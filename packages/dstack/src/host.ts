import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodingWorkspaceOwner } from "./conversation.js";
import { acquireLock } from "./lock.js";
import {
  HostError,
  MAX_PENDING_INPUTS,
  MAX_WORKSPACES,
  parseOperation,
  type HostConfig,
  type HostMutation,
  type HostOperation,
} from "#host-protocol";

const context = BACKGROUND_CONTEXT;

export class DurableHost {
  readonly #owners = new Map<string, CodingWorkspaceOwner>();
  #closing: Promise<void> | null = null;
  #active: Promise<unknown> | null = null;

  private constructor(
    readonly config: HostConfig,
    private readonly models: Models,
    private readonly db: DatabaseSync,
    private readonly unlock: () => Promise<void>,
  ) {}

  static async open(config: HostConfig, models: Models): Promise<DurableHost> {
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
      host = new DurableHost({ ...config, stateRoot }, models, db, unlock);
      for (const row of db.prepare("SELECT id, cwd FROM workspaces ORDER BY id").all()) {
        if (typeof row.id !== "string" || typeof row.cwd !== "string")
          throw new Error("Invalid workspace index");
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

  private async openWorkspace(workspaceId: string, cwd: string): Promise<CodingWorkspaceOwner> {
    if ((await realpath(cwd)) !== cwd)
      throw new HostError("binding_mismatch", "Canonical workspace cwd was retargeted");
    const existing = this.#owners.get(workspaceId);
    if (existing !== undefined) return existing;
    if (this.#owners.size >= MAX_WORKSPACES)
      throw new HostError("capacity", "Host workspace limit reached");
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "herdr.files",
        tools: [createReadTool(), createWriteTool(), createEditTool()],
      }),
    );
    const owner = await CodingWorkspaceOwner.open(
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
        models: this.models,
        model: this.config.model,
        initialThinkingLevel: this.config.thinkingLevel,
        registry,
        execution: "trusted-user",
        lockCommand: { file: process.env.DSTACK_FLOCK || "flock", args: [] },
      },
      context,
    );
    this.#owners.set(workspaceId, owner);
    return owner;
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

  handle(operation: HostOperation): Promise<unknown> {
    if (this.#closing !== null)
      return Promise.reject(new HostError("unavailable", "Host admission is sealed"));
    if (this.#active !== null)
      return Promise.reject(new HostError("busy", "Host already has an in-flight request"));
    const active = this.dispatch(operation);
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
      try {
        this.db.close();
      } finally {
        await this.unlock();
      }
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "Host workspace cleanup failed");
    })();
    return this.#closing;
  }
}
