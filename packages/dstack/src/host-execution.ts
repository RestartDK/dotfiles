import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CommandDirectory, missingFile } from "./command-store.js";
import { ExecutionCatalogue, type CatalogueEntry } from "./execution-catalogue.js";
import { ExecutionCommands } from "./execution-commands.js";
import type { CommandRuntime } from "./command-runtime.js";
import { unresolvedEffects } from "./execution-domain.js";
import { ExecutionJournal } from "./execution-journal.js";
import { executionRootBytes, type ExecutionRoot } from "./execution-wire.js";
import { HostError, type HostConfig, type HostMutation } from "#host-protocol";

export type ManagedWorkspace = {
  readonly root: ExecutionRoot;
  readonly journal: ExecutionJournal;
  readonly commands: CommandDirectory;
  readonly commandOwner?: ExecutionCommands;
};

export type HostCommandRuntime = { readonly runtime: CommandRuntime; readonly sourceBootId: string };
type Options = { readonly config: HostConfig; readonly db: DatabaseSync; readonly commands?: HostCommandRuntime };
type Creation = Extract<HostMutation, { op: "create" }>;
const executionTables = ["herdr_execution_index", "herdr_managed_workspaces", "herdr_execution_roots", "herdr_execution_records"];

export class HostExecution {
  readonly #workspaces = new Map<string, ManagedWorkspace>();
  #closing: Promise<void> | null = null;

  private constructor(
    private readonly options: Options,
    private readonly directory: CommandDirectory,
    private readonly workspaces: CommandDirectory,
    readonly catalogue: ExecutionCatalogue,
    private readonly release: () => Promise<void>,
  ) {}

  static async open(options: Options): Promise<HostExecution | undefined> {
    const path = join(options.config.stateRoot, "execution");
    const info = await lstat(path).catch(error => { if (missingFile(error)) return undefined; throw error; });
    const tables = options.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .filter(row => typeof row.name === "string" && executionTables.includes(row.name));
    if (options.config.execution === undefined) {
      if (info !== undefined || tables.length !== 0)
        throw new HostError("execution_required", "Managed execution evidence requires enabled ownership");
      return undefined;
    }
    const initialization = info === undefined && tables.length === 0 ? "new" : "existing";
    if (initialization === "existing" && (info === undefined || tables.length < 2))
      throw new HostError("execution_incomplete", "Execution catalogue is missing or partially initialized");
    if (initialization === "new") await mkdir(path, { mode: 0o700 });
    const lease = await CommandDirectory.own({ path, lockCommand: { file: process.env.DSTACK_FLOCK ?? "flock", args: [] } });
    let catalogue: ExecutionCatalogue | undefined;
    let execution: HostExecution | undefined;
    try {
      const catalogueDirectory = await lease.directory.child("catalogue", initialization);
      const workspaces = await lease.directory.child("workspaces", initialization);
      const input = { db: options.db, directory: catalogueDirectory, identity: options.config.identity };
      catalogue = initialization === "new" ? await ExecutionCatalogue.initialize(input) : await ExecutionCatalogue.open(input);
      execution = new HostExecution(options, lease.directory, workspaces, catalogue, lease.close);
      for (const entry of await catalogue.snapshot()) await execution.openWorkspace(entry, "existing");
      await execution.snapshot();
      return execution;
    } catch (error) {
      try {
        if (execution !== undefined) await execution.close();
        else { await catalogue?.close(); await lease.close(); }
      } catch (cleanup) { throw new AggregateError([error, cleanup], "Execution host open and cleanup failed"); }
      throw error;
    }
  }

  private async openWorkspace(entry: CatalogueEntry, initialization: "new" | "existing"): Promise<ManagedWorkspace> {
    const directory = await this.workspaces.child(entry.root.rootId, initialization);
    const journalDirectory = await directory.child("journal", initialization);
    const commands = await directory.child("commands", initialization);
    const input = { db: this.options.db, directory: journalDirectory, root: entry.root, maxRecords: this.options.config.execution?.maxRecords ?? 16384 };
    const journal = initialization === "new" ? await ExecutionJournal.initialize(input) : await ExecutionJournal.open(input);
    try {
      const commandOwner = this.options.commands === undefined ? undefined : await ExecutionCommands.open({ ...this.options.commands, journal, directory: commands });
      const managed = { root: entry.root, journal, commands, commandOwner };
      this.#workspaces.set(entry.root.workspace.workspaceId, managed);
      return managed;
    } catch (error) {
      try { await journal.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Managed command owner open and cleanup failed"); }
      throw error;
    }
  }

  async snapshot(): Promise<readonly ManagedWorkspace[]> {
    const layout = (await readdir(this.directory.path)).sort();
    if (layout.join("\n") !== ["catalogue", "workspaces", "writer.lock"].join("\n"))
      throw new HostError("execution_incomplete", "Execution host layout is missing or orphaned");
    const entries = await this.catalogue.snapshot();
    const roots = entries.map(entry => entry.root.rootId).sort();
    const external = (await readdir(this.workspaces.path)).sort();
    if (roots.join("\n") !== external.join("\n"))
      throw new HostError("execution_incomplete", "Execution workspace directory is missing or orphaned");
    const tables = this.options.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const rootsPresent = tables.some(row => row.name === "herdr_execution_roots");
    const recordsPresent = tables.some(row => row.name === "herdr_execution_records");
    if (rootsPresent !== recordsPresent || (entries.length !== 0 && !rootsPresent))
      throw new HostError("execution_incomplete", "Execution journal tables are missing");
    const stored = rootsPresent ? this.options.db.prepare("SELECT id FROM herdr_execution_roots ORDER BY id").all() : [];
    if (stored.length !== roots.length || stored.some((row, index) => row.id !== roots[index]))
      throw new HostError("execution_incomplete", "Execution SQLite roots are missing or orphaned");
    if (recordsPresent && this.options.db.prepare("SELECT root_id FROM herdr_execution_records WHERE root_id NOT IN (SELECT id FROM herdr_execution_roots) LIMIT 1").get() !== undefined)
      throw new HostError("execution_incomplete", "Execution SQLite records are orphaned");
    const managed: ManagedWorkspace[] = [];
    for (const entry of entries) {
      const workspace = this.#workspaces.get(entry.root.workspace.workspaceId);
      if (workspace === undefined || executionRootBytes(workspace.root) !== executionRootBytes(entry.root))
        throw new HostError("execution_incomplete", "Execution workspace ownership differs");
      const directory = await this.workspaces.child(entry.root.rootId, "existing");
      if ((await readdir(directory.path)).sort().join("\n") !== ["commands", "journal"].join("\n"))
        throw new HostError("execution_incomplete", "Execution workspace layout differs");
      const { state } = await workspace.journal.snapshot();
      if (workspace.commandOwner !== undefined) await workspace.commandOwner.snapshot();
      else if (state.commands.size !== 0 || (await readdir(workspace.commands.path)).length !== 0)
        throw new HostError("execution_required", "Command evidence requires its command runtime");
      managed.push(workspace);
    }
    return managed;
  }

  get(workspaceId: string): ManagedWorkspace | undefined { return this.#workspaces.get(workspaceId); }

  async admit(operation: Creation, cwd: string): Promise<ManagedWorkspace> {
    if (this.#closing !== null) throw new HostError("unavailable", "Execution host is closed");
    await this.snapshot();
    const existing = this.#workspaces.get(operation.workspaceId);
    if (existing !== undefined) {
      const entry = (await this.catalogue.snapshot()).find(entry => entry.root.workspace.workspaceId === operation.workspaceId);
      if (entry?.requestId !== operation.requestId)
        throw new HostError("request_conflict", "Managed workspace has another creation request");
      await this.catalogue.admit({ root: existing.root, operation });
      return existing;
    }
    const root = {
      version: 1, rootId: randomUUID(), token: randomBytes(32).toString("hex"),
      workspace: { domain: this.options.config.identity.domain, nodeId: this.options.config.identity.nodeId, workspaceId: operation.workspaceId, cwd },
    } satisfies ExecutionRoot;
    const admission = await this.catalogue.admit({ root, operation });
    return this.openWorkspace(admission.entry, admission.kind === "created" ? "new" : "existing");
  }

  async assertProgress(workspaceId: string): Promise<void> {
    const workspace = this.get(workspaceId);
    if (workspace === undefined) return;
    await this.catalogue.assertBinding(workspace.root);
    const { state } = await workspace.journal.snapshot();
    if (unresolvedEffects(state).length !== 0)
      throw new HostError("effect_unresolved", "Unresolved execution effects block workspace progress");
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      const errors: unknown[] = [];
      for (const workspace of this.#workspaces.values()) {
        try { await workspace.commandOwner?.close(); } catch (error) { errors.push(error); }
        try { await workspace.journal.close(); } catch (error) { errors.push(error); }
      }
      try { await this.catalogue.close(); } catch (error) { errors.push(error); }
      try { await this.release(); } catch (error) { errors.push(error); }
      if (errors.length !== 0) throw new AggregateError(errors, "Execution host cleanup failed");
    })();
    return this.#closing;
  }
}
