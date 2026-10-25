import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { CompactionTask, GenerationTask, ToolTask, createRegistry, defineExtension, hook } from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodingWorkspaceDoc, CodingWorkspaceOwner, type PreparedCodingWorkspace } from "./conversation.js";
import { ExecutionRootDoc } from "./execution-binding.js";
import { workspaceFileTools } from "./execution-files.js";
import { executionRootBytes } from "./execution-wire.js";
import { HostExecution, type HostCommandRuntime } from "./host-execution.js";
import { hostCommandTask } from "./host-command-task.js";
import { executionModels } from "./execution-models.js";
import type { CommandAuthorizationInput, TrustedReconciliation } from "./execution-commands.js";
import { WorkspacePaths } from "./workspace-paths.js";
import { isDeepStrictEqual } from "node:util";
import { acquireLock } from "./lock.js";
import {
  HostError,
  MAX_PENDING_INPUTS,
  MAX_WORKSPACES,
  parseHostConfig,
  parseOperation,
  type HostConfig,
  type HostMutation,
  type HostOperation,
} from "#host-protocol";

const context = BACKGROUND_CONTEXT;

export type TrustedHostCommandOperation =
  | { readonly op: "authorize"; readonly workspaceId: string; readonly authorization: CommandAuthorizationInput }
  | { readonly op: "start" | "describe" | "inspect" | "adopt" | "cancel" | "release"; readonly workspaceId: string; readonly intentId: string }
  | { readonly op: "reconcile"; readonly workspaceId: string; readonly reconciliation: TrustedReconciliation }
  | { readonly op: "file.reconcile"; readonly workspaceId: string; readonly effectId: string; readonly actor: string; readonly reference: string };

export class DurableHost {
  readonly #owners = new Map<string, CodingWorkspaceOwner>();
  readonly #prepared = new Map<string, PreparedCodingWorkspace>();
  #execution: HostExecution | undefined;
  readonly #commandTasks = new Map<string, ReturnType<typeof hostCommandTask>>();
  #closing: Promise<void> | null = null;
  #active: Promise<unknown> | null = null;

  private constructor(
    readonly config: HostConfig,
    private readonly models: Models,
    private readonly db: DatabaseSync,
    private readonly unlock: () => Promise<void>,
    private readonly protectedPaths: readonly string[],
  ) {}

  static async open(config: HostConfig, models: Models, options: { readonly protectedPaths?: readonly string[]; readonly commands?: HostCommandRuntime } = {}): Promise<DurableHost> {
    config = parseHostConfig(JSON.parse(JSON.stringify(config)));
    const protectedPaths = [...(options.protectedPaths ?? [])];
    const commands = options.commands === undefined ? undefined : { ...options.commands };
    await mkdir(config.stateRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(config.stateRoot);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new HostError("unsafe_store", "Host root must be private, owned, and not a symlink");
    const stateRoot = await realpath(config.stateRoot);
    try {
      await lstat(join(stateRoot, "jobs.sqlite"));
      throw new HostError("unsafe_store", "Host root must be separate from jobs.sqlite");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const unlock = await acquireLock(
      stateRoot,
      { file: process.env.DSTACK_FLOCK || "flock", args: [] },
      { name: "host.lock", waitSeconds: 0 },
    );
    let db: DatabaseSync | undefined;
    let host: DurableHost | undefined;
    try {
      const path = join(stateRoot, "host.sqlite");
      const file = await open(
        path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0
        )
          throw new HostError(
            "unsafe_store",
            "Host index must be a private owned file without aliases",
          );
      } finally {
        await file.close();
      }
      db = new DatabaseSync(path);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS admissions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, admitted INTEGER NOT NULL DEFAULT 0);`);
      const binding = JSON.stringify({ ...config.identity, stateRoot, version: 1 });
      const stored = db.prepare("SELECT value FROM binding WHERE id=1").get();
      if (stored === undefined) db.prepare("INSERT INTO binding VALUES (1, ?)").run(binding);
      else if (stored.value !== binding)
        throw new HostError("binding_mismatch", "Host root identity differs");
      host = new DurableHost({ ...config, stateRoot }, models, db, unlock, protectedPaths);
      const rows = db.prepare("SELECT id, cwd FROM workspaces ORDER BY id").all();
      if (rows.length > MAX_WORKSPACES) throw new HostError("capacity", "Host workspace limit reached");
      const expected = new Set(rows.map(row => {
        if (typeof row.id !== "string" || typeof row.cwd !== "string") throw new Error("Invalid workspace index");
        return createHash("sha256").update(row.id).digest("hex");
      }));
      for (const name of await readdir(stateRoot))
        if (/^[0-9a-f]{64}$/.test(name) && !expected.has(name))
          throw new HostError("execution_incomplete", "Workspace state is orphaned from the host index");
      host.#execution = await HostExecution.open({ config: host.config, db, commands });
      for (const row of rows) {
        if (typeof row.id !== "string" || typeof row.cwd !== "string") throw new Error("Invalid workspace index");
        await host.prepareWorkspace(row.id, row.cwd, "existing");
      }
      for (const row of rows) {
        if (typeof row.id !== "string" || typeof row.cwd !== "string") throw new Error("Invalid workspace index");
        await host.openWorkspace(row.id, row.cwd);
      }
      for (const row of db
        .prepare("SELECT payload FROM admissions WHERE admitted=0 ORDER BY rowid")
        .all()) {
        if (typeof row.payload !== "string") throw new Error("Invalid admission journal");
        const operation = parseOperation(JSON.parse(row.payload));
        if (operation.op !== "create" && operation.op !== "submit")
          throw new Error("Invalid journal operation");
        await host.apply(operation);
      }
      for (const [workspaceId, owner] of host.#owners) {
        try { await host.assertProgress(workspaceId); owner.harness.resume(); }
        catch (error) { if (!(error instanceof HostError && error.code === "effect_unresolved")) throw error; }
      }
      return host;
    } catch (error) {
      if (host !== undefined) await host.close();
      else {
        try {
          db?.close();
        } finally {
          await unlock();
        }
      }
      throw error;
    }
  }

  private async prepareWorkspace(workspaceId: string, cwd: string, initialization: "new" | "existing"): Promise<PreparedCodingWorkspace> {
    if ((await realpath(cwd)) !== cwd)
      throw new HostError("binding_mismatch", "Canonical workspace cwd was retargeted");
    const existing = this.#prepared.get(workspaceId);
    if (existing !== undefined) return existing;
    if (this.#prepared.size >= MAX_WORKSPACES)
      throw new HostError("capacity", "Host workspace limit reached");
    const managed = this.#execution?.get(workspaceId);
    const paths = await WorkspacePaths.open({ cwd, protectedPaths: [this.config.stateRoot, this.config.authPath, this.config.modelsPath, ...this.protectedPaths] });
    const gate = () => this.assertProgress(workspaceId);
    const registry = createRegistry();
    registry.install(defineExtension({
      ...workspaceFileTools({ paths, ownership: managed === undefined ? { kind: "legacy" } : { kind: "managed", journal: managed.journal, beforeMutation: gate } }),
      name: "herdr.files",
      hooks: [hook(GenerationTask, { beforeRequest: async () => { await gate(); return undefined; } }), hook(CompactionTask, { beforeCompact: async () => { await gate(); return undefined; } }), hook(ToolTask, { beforeTool: async () => { await gate(); return undefined; } })],
    }));
    if (managed?.commandOwner !== undefined) {
      const task = hostCommandTask({
        assertBinding: async conversationKey => {
          await this.assertOwnership(workspaceId);
          if (String(this.owner(workspaceId).conversation.id) !== conversationKey) throw new HostError("execution_incomplete", "Command task belongs to another conversation");
        },
        owner: () => this.commandOwner(workspaceId),
      });
      registry.install(defineExtension({ name: "herdr.command-owner", tasks: [task] }));
      this.#commandTasks.set(workspaceId, task);
    }
    const owner = await CodingWorkspaceOwner.prepare(
      {
        workspace: {
          domain: this.config.identity.domain,
          nodeId: this.config.identity.nodeId,
          workspaceId,
          cwd,
        },
        stateDirectory: join(
          this.config.stateRoot,
          createHash("sha256").update(workspaceId).digest("hex"),
        ),
        models: executionModels(this.models, gate),
        model: this.config.model,
        initialThinkingLevel: this.config.thinkingLevel,
        registry,
        execution: "trusted-user",
        startup: "deferred",
        ...(managed === undefined ? {} : { management: { root: managed.root, initialization } }),
        lockCommand: { file: process.env.DSTACK_FLOCK || "flock", args: [] },
      },
      context,
    );
    this.#prepared.set(workspaceId, owner);
    return owner;
  }

  private async openWorkspace(workspaceId: string, cwd: string, initialization: "new" | "existing" = "existing"): Promise<CodingWorkspaceOwner> {
    const existing = this.#owners.get(workspaceId);
    if (existing !== undefined) return existing;
    const prepared = await this.prepareWorkspace(workspaceId, cwd, initialization);
    const owner = await prepared.open(context);
    this.#owners.set(workspaceId, owner);
    return owner;
  }

  private async assertProgress(workspaceId: string): Promise<void> {
    await this.#execution?.assertProgress(workspaceId);
    await this.assertOwnership(workspaceId);
  }

  private async assertOwnership(workspaceId: string): Promise<void> {
    const managedBinding = this.#execution?.get(workspaceId);
    if (managedBinding !== undefined) await this.#execution?.catalogue.assertBinding(managedBinding.root);
    const owner = this.owner(workspaceId);
    const marker = await owner.harness.snapshot(ExecutionRootDoc, context);
    const managed = this.#execution?.get(workspaceId);
    if (managed === undefined) {
      if (marker?.rootJson !== undefined && marker.rootJson !== null)
        throw new HostError("execution_required", "Managed coding workspace requires execution ownership");
    } else {
      const binding = await owner.harness.snapshot(CodingWorkspaceDoc, context);
      if (marker?.rootJson !== executionRootBytes(managed.root) || !isDeepStrictEqual(binding?.workspace, managed.root.workspace))
        throw new HostError("execution_incomplete", "Managed coding workspace binding is missing or changed");
    }
  }

  private owner(workspaceId: string): CodingWorkspaceOwner {
    const owner = this.#owners.get(workspaceId);
    if (owner === undefined) throw new HostError("not_found", "Unknown workspace");
    return owner;
  }

  private describe(owner: CodingWorkspaceOwner) {
    return { ...owner.workspace, conversationId: owner.conversation.id };
  }

  private async apply(operation: HostMutation) {
    if (operation.op === "create") {
      const stored = this.db
        .prepare("SELECT cwd FROM workspaces WHERE id=?")
        .get(operation.workspaceId);
      if (typeof stored?.cwd !== "string")
        throw new HostError("not_found", "Missing admitted workspace binding");
      const cwd = stored.cwd;
      const owner = await this.openWorkspace(operation.workspaceId, cwd);
      this.db.prepare("UPDATE admissions SET admitted=1 WHERE id=?").run(operation.requestId);
      return this.describe(owner);
    }
    const owner = this.owner(operation.workspaceId);
    await this.assertProgress(operation.workspaceId);
    const submission = await owner.conversation.submit(
      {
        type: "input",
        content: operation.content,
        requestId: operation.requestId,
        whenBusy: "followUp",
      },
      context,
    );
    this.db.prepare("UPDATE admissions SET admitted=1 WHERE id=?").run(operation.requestId);
    return {
      workspaceId: operation.workspaceId,
      conversationId: owner.conversation.id,
      requestId: operation.requestId,
      receipt: await submission.status(context),
    };
  }

  private request<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing !== null)
      return Promise.reject(new HostError("unavailable", "Host admission is sealed"));
    if (this.#active !== null)
      return Promise.reject(new HostError("busy", "Host already has an in-flight request"));
    const active = operation();
    this.#active = active;
    void active.then(
      () => {
        this.#active = null;
      },
      () => {
        this.#active = null;
      },
    );
    return active;
  }

  handle(operation: HostOperation): Promise<unknown> {
    return this.request(() => this.dispatch(operation));
  }

  private commandOwner(workspaceId: string) {
    const owner = this.#execution?.get(workspaceId)?.commandOwner;
    if (owner === undefined) throw new HostError("execution_required", "Workspace has no configured command owner");
    return owner;
  }

  command(request: TrustedHostCommandOperation): Promise<unknown> {
    const operation = structuredClone(request);
    return this.request(async () => {
      await this.assertOwnership(operation.workspaceId);
      const commands = this.commandOwner(operation.workspaceId);
      switch (operation.op) {
        case "authorize": return commands.authorize(operation.authorization);
        case "describe": return commands.describe(operation.intentId);
        case "inspect": return commands.inspect(operation.intentId);
        case "adopt": return commands.adopt(operation.intentId);
        case "cancel": return commands.cancel(operation.intentId);
        case "release": await commands.release(operation.intentId); return { released: true };
        case "reconcile": return commands.reconcile(operation.reconciliation);
        case "file.reconcile": {
          const managed = this.#execution?.get(operation.workspaceId);
          if (managed === undefined) throw new HostError("execution_required", "Managed journal unavailable");
          await managed.journal.append({ kind: "file.reconciled", effectId: operation.effectId, actor: operation.actor, reference: operation.reference });
          return { reconciled: true };
        }
        case "start": {
          const current = await commands.describe(operation.intentId);
          if (current.command.phase.kind !== "authorized") return current;
          if (current.grant !== "live") throw new HostError("expired_grant", "Command source grant is expired or revoked; authorize a new intent");
          await this.assertProgress(operation.workspaceId);
          const task = this.#commandTasks.get(operation.workspaceId);
          if (task === undefined) throw new HostError("execution_required", "Owned command task unavailable");
          const owner = this.owner(operation.workspaceId);
          const id = await owner.conversation.commit(tx => tx.createTask(task, { intentId: operation.intentId }, { ownership: { kind: "conversation" } }), context);
          owner.harness.resume();
          return { intentId: operation.intentId, taskKey: String(id), conversationKey: String(owner.conversation.id) };
        }
      }
    });
  }

  private async dispatch(operation: HostOperation): Promise<unknown> {
    switch (operation.op) {
      case "discover":
        return {
          identity: this.config.identity,
          workspaces: [...this.#owners.values()].map((owner) => this.describe(owner)),
        };
      case "snapshot": {
        const owner = this.owner(operation.workspaceId);
        const page = await owner.conversation.entries({}, 20, undefined, context);
        return {
          workspace: this.describe(owner),
          entries: page.items,
          hasMore: page.next !== undefined,
        };
      }
      case "status": {
        const owner = this.owner(operation.workspaceId);
        const receipt = await owner.harness.commit(
          (tx) => tx.submissionByRequest(owner.conversation.id, operation.requestId),
          context,
        );
        return {
          workspaceId: operation.workspaceId,
          requestId: operation.requestId,
          receipt: receipt ?? null,
        };
      }
      case "create":
      case "submit": {
        const payload = JSON.stringify(operation);
        const existing = this.db
          .prepare("SELECT payload FROM admissions WHERE id=?")
          .get(operation.requestId);
        if (existing !== undefined && existing.payload !== payload)
          throw new HostError("request_conflict", "Request ID is already bound to another payload");
        if (existing === undefined) {
          if (operation.op === "create") {
            const cwd = await realpath(operation.cwd);
            if (!(await lstat(cwd)).isDirectory())
              throw new HostError("invalid_cwd", "Workspace cwd must be a directory");
            const stored = this.db
              .prepare("SELECT cwd FROM workspaces WHERE id=?")
              .get(operation.workspaceId);
            if (stored !== undefined && stored.cwd !== cwd)
              throw new HostError("binding_mismatch", "Workspace ID cannot retarget cwd");
            if (
              stored === undefined &&
              this.db
                .prepare("SELECT id FROM workspaces LIMIT 1 OFFSET ?")
                .get(MAX_WORKSPACES - 1) !== undefined
            )
              throw new HostError("capacity", "Host workspace limit reached");
            if (this.#execution !== undefined && stored === undefined) {
              await this.#execution.admit(operation, cwd);
              await this.openWorkspace(operation.workspaceId, cwd, "new");
              await this.assertProgress(operation.workspaceId);
              return this.apply(operation);
            }
            this.db.exec("BEGIN IMMEDIATE");
            try {
              if (stored === undefined)
                this.db
                  .prepare("INSERT INTO workspaces VALUES (?, ?)")
                  .run(operation.workspaceId, cwd);
              this.db
                .prepare("INSERT INTO admissions (id, payload) VALUES (?, ?)")
                .run(operation.requestId, payload);
              this.db.exec("COMMIT");
            } catch (error) {
              this.db.exec("ROLLBACK");
              throw error;
            }
          } else {
            await this.assertProgress(operation.workspaceId);
            const inspection = await this.owner(operation.workspaceId).harness.inspect(context);
            if (inspection.submissions.length >= MAX_PENDING_INPUTS)
              throw new HostError("busy", "Workspace admission limit reached");
            this.db
              .prepare("INSERT INTO admissions (id, payload) VALUES (?, ?)")
              .run(operation.requestId, payload);
          }
        }
        return this.apply(operation);
      }
    }
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      await this.#active?.catch(() => undefined);
      const results = await Promise.allSettled(
        [...this.#owners.values()].map((owner) => owner.close()),
      );
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      for (const prepared of this.#prepared.values()) {
        try { await prepared.close(); } catch (error) { errors.push(error); }
      }
      try { await this.#execution?.close(); } catch (error) { errors.push(error); }
      try { this.db.close(); } catch (error) { errors.push(error); }
      try { await this.unlock(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Host workspace cleanup failed");
    })();
    return this.#closing;
  }
}
