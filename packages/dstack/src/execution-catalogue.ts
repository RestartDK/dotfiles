import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { isAbsolute, join, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { CommandDirectory } from "./command-store.js";
import { requireDurableSqlite } from "./execution-sqlite.js";
import { executionRootBytes, parseExecutionRoot, type ExecutionRoot } from "./execution-wire.js";
import { MAX_WORKSPACES, parseOperation, type HostIdentity, type HostMutation } from "#host-protocol";
import { isIdentityName } from "./workspace-identity.js";
import { parseControlPaths } from "./host-protection.js";

const IdentitySchema = Type.Object({ deploymentId: Type.String(), domain: Type.Union([Type.Literal("personal"), Type.Literal("work")]), nodeId: Type.String() }, { additionalProperties: false });
const AnchorSchema = Type.Object({
  version: Type.Literal(1), indexId: Type.String(), token: Type.String({ pattern: "^[0-9a-f]{64}$" }), identity: IdentitySchema,
}, { additionalProperties: false });
const HostBindingFields = { ...IdentitySchema.properties, stateRoot: Type.String() };
const HostBindingSchema = Type.Union([
  Type.Object({ ...HostBindingFields, version: Type.Union([Type.Literal(2), Type.Literal(3)]) }, { additionalProperties: false }),
  Type.Object({ ...HostBindingFields, version: Type.Literal(4), clientMode: Type.Union([Type.Literal("native"), Type.Literal("authenticated")]), controlPaths: Type.Array(Type.String(), { minItems: 1, maxItems: 64 }) }, { additionalProperties: false }),
]);
type Anchor = Static<typeof AnchorSchema>;
type Identity = HostIdentity;
type Options = { readonly db: DatabaseSync; readonly directory: CommandDirectory; readonly identity: Identity };
type Work = { readonly kind: "open"; tail: Promise<void> } | { readonly kind: "closing"; readonly completion: Promise<void> };
export type CatalogueEntry = { readonly root: ExecutionRoot; readonly requestId: string };
export type CatalogueAdmission = { readonly kind: "created" | "attached"; readonly entry: CatalogueEntry };

function parseAnchor(bytes: string): Anchor {
  if (Buffer.byteLength(bytes) > 16384) throw new Error("Execution catalogue anchor exceeds limit");
  const value: unknown = JSON.parse(bytes);
  if (!Check(AnchorSchema, value)) throw new Error("Invalid execution catalogue anchor");
  for (const name of [value.indexId, value.identity.deploymentId, value.identity.nodeId])
    if (!name.isWellFormed() || name.includes("\0") || !isIdentityName(name) || Buffer.byteLength(name) > 200)
      throw new Error("Invalid execution catalogue identity");
  Object.freeze(value.identity);
  return Object.freeze(value);
}
function hostBinding(input: Options): string {
  const row = input.db.prepare("SELECT value FROM binding WHERE id=1").get();
  if (typeof row?.value !== "string") throw new Error("Execution catalogue requires an existing host binding");
  const binding: unknown = JSON.parse(row.value);
  const main = input.db.prepare("PRAGMA database_list").all().find(row => row.name === "main");
  if (!Check(HostBindingSchema, binding) || binding.deploymentId !== input.identity.deploymentId || binding.domain !== input.identity.domain || binding.nodeId !== input.identity.nodeId || !isAbsolute(binding.stateRoot) || !binding.stateRoot.isWellFormed() || binding.stateRoot.includes("\0") || main?.file !== join(binding.stateRoot, "host.sqlite") || !input.directory.path.startsWith(`${binding.stateRoot}${sep}`))
    throw new Error("Execution catalogue differs from its borrowed host index");
  if (binding.version === 4 && JSON.stringify(parseControlPaths(binding.controlPaths)) !== JSON.stringify(binding.controlPaths))
    throw new Error("Execution catalogue control protection is not canonical");
  if (input.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workspaces','admissions')").all().length !== 2)
    throw new Error("Execution catalogue requires the host admission schema");
  return row.value;
}
function rootFile(workspaceId: string): string { return `${createHash("sha256").update(workspaceId).digest("hex")}.json`; }

export class ExecutionCatalogue {
  #work: Work = { kind: "open", tail: Promise.resolve() };

  private constructor(
    readonly anchor: Anchor,
    private readonly bytes: string,
    private readonly hostBytes: string,
    private readonly db: DatabaseSync,
    private readonly directory: CommandDirectory,
    private readonly roots: CommandDirectory,
  ) {}

  static async initialize(input: Options): Promise<ExecutionCatalogue> {
    requireDurableSqlite(input.db, "Execution catalogue");
    const bytes = JSON.stringify({ version: 1, indexId: randomUUID(), token: randomBytes(32).toString("hex"), identity: { ...input.identity } });
    const anchor = parseAnchor(bytes);
    const hostBytes = hostBinding({ ...input, identity: anchor.identity });
    if (input.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('herdr_execution_index','herdr_managed_workspaces')").all().length !== 0 || (await readdir(input.directory.path)).length !== 0)
      throw new Error("Execution catalogue initialization requires new metadata");
    const roots = await input.directory.child("roots", "new");
    await input.directory.create("index.json", bytes);
    const catalogue = new ExecutionCatalogue(anchor, bytes, hostBytes, input.db, input.directory, roots);
    catalogue.transaction(() => {
      input.db.exec(`CREATE TABLE herdr_execution_index (id INTEGER PRIMARY KEY CHECK(id=1), anchor_json TEXT NOT NULL);
        CREATE TABLE herdr_managed_workspaces (workspace_id TEXT PRIMARY KEY, root_id TEXT NOT NULL UNIQUE, root_json TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE);`);
      input.db.prepare("INSERT INTO herdr_execution_index VALUES (1, ?)").run(bytes);
      return undefined;
    });
    await catalogue.snapshot();
    return catalogue;
  }

  static async open(input: Options): Promise<ExecutionCatalogue> {
    requireDurableSqlite(input.db, "Execution catalogue");
    const identity = { ...input.identity };
    const hostBytes = hostBinding({ ...input, identity });
    const bytes = await input.directory.read("index.json", 16384);
    const anchor = parseAnchor(bytes);
    if (anchor.identity.deploymentId !== identity.deploymentId || anchor.identity.domain !== identity.domain || anchor.identity.nodeId !== identity.nodeId)
      throw new Error("Execution catalogue host identity differs");
    const catalogue = new ExecutionCatalogue(anchor, bytes, hostBytes, input.db, input.directory, await input.directory.child("roots", "existing"));
    await catalogue.snapshot();
    return catalogue;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#work.kind !== "open") return Promise.reject(new Error("Execution catalogue is closed"));
    const pending = this.#work.tail.then(operation);
    this.#work.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private transaction(operation: () => undefined): void {
    requireDurableSqlite(this.db, "Execution catalogue");
    this.db.exec("BEGIN IMMEDIATE");
    try { operation(); this.db.exec("COMMIT"); }
    catch (error) {
      try { this.db.exec("ROLLBACK"); }
      catch (rollback) { throw new AggregateError([error, rollback], "Execution catalogue transaction failed"); }
      throw error;
    }
  }

  private async header(): Promise<void> {
    requireDurableSqlite(this.db, "Execution catalogue");
    if (hostBinding({ db: this.db, directory: this.directory, identity: this.anchor.identity }) !== this.hostBytes)
      throw new Error("Execution catalogue host binding changed");
    const rows = this.db.prepare("SELECT id, anchor_json FROM herdr_execution_index").all();
    if (rows.length !== 1 || rows[0]?.id !== 1 || rows[0].anchor_json !== this.bytes || await this.directory.read("index.json", 16384) !== this.bytes)
      throw new Error("Execution catalogue anchor is missing or changed");
    const names = (await readdir(this.directory.path)).sort();
    if (names.length !== 2 || names[0] !== "index.json" || names[1] !== "roots")
      throw new Error("Execution catalogue external layout changed");
  }

  private async entry(workspaceId: string): Promise<CatalogueEntry> {
    const row = this.db.prepare("SELECT root_id, root_json, request_id FROM herdr_managed_workspaces WHERE workspace_id=?").get(workspaceId);
    if (typeof row?.root_json !== "string" || typeof row.root_id !== "string" || typeof row.request_id !== "string") throw new Error("Managed workspace mapping is missing");
    const root = parseExecutionRoot(row.root_json);
    if (root.rootId !== row.root_id || root.workspace.workspaceId !== workspaceId || root.workspace.domain !== this.anchor.identity.domain || root.workspace.nodeId !== this.anchor.identity.nodeId)
      throw new Error("Managed workspace differs from catalogue identity");
    const workspace = this.db.prepare("SELECT cwd FROM workspaces WHERE id=?").get(workspaceId);
    const admission = this.db.prepare("SELECT payload FROM admissions WHERE id=?").get(row.request_id);
    if (workspace?.cwd !== root.workspace.cwd || typeof admission?.payload !== "string")
      throw new Error("Managed workspace or creation admission is missing or changed");
    const operation = parseOperation(JSON.parse(admission.payload));
    if (operation.op !== "create" || operation.workspaceId !== workspaceId || operation.requestId !== row.request_id)
      throw new Error("Managed workspace creation admission differs");
    if (await this.roots.read(rootFile(workspaceId), 32768) !== row.root_json)
      throw new Error("Managed workspace external root is missing or changed");
    return { root, requestId: row.request_id };
  }

  private async inspect(): Promise<readonly CatalogueEntry[]> {
    await this.header();
    const rows = this.db.prepare("SELECT workspace_id FROM herdr_managed_workspaces ORDER BY workspace_id").all();
    if (rows.length > MAX_WORKSPACES) throw new Error("Execution catalogue capacity exceeded");
    const entries: CatalogueEntry[] = [];
    for (const row of rows) {
      if (typeof row.workspace_id !== "string") throw new Error("Invalid managed workspace row");
      const entry = await this.entry(row.workspace_id);
      if (entries.some(previous => previous.root.rootId === entry.root.rootId))
        throw new Error("Execution root identity is shared across workspaces");
      entries.push(entry);
    }
    const expected = entries.map(entry => rootFile(entry.root.workspace.workspaceId)).sort();
    const actual = (await readdir(this.roots.path)).sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
      throw new Error("Execution catalogue history is missing or orphaned");
    requireDurableSqlite(this.db, "Execution catalogue");
    return entries;
  }

  snapshot(): Promise<readonly CatalogueEntry[]> { return this.run(() => this.inspect()); }

  assertBinding(input: ExecutionRoot): Promise<void> {
    const expected = executionRootBytes(parseExecutionRoot(executionRootBytes(input)));
    return this.run(async () => {
      await this.header();
      const root = parseExecutionRoot(expected);
      const entry = await this.entry(root.workspace.workspaceId);
      const owners = this.db.prepare("SELECT workspace_id FROM herdr_managed_workspaces WHERE root_id=?").all(root.rootId);
      if (owners.length !== 1 || owners[0]?.workspace_id !== root.workspace.workspaceId)
        throw new Error("Execution root identity is shared across workspaces");
      if (executionRootBytes(entry.root) !== expected) throw new Error("Managed execution identity differs");
      requireDurableSqlite(this.db, "Execution catalogue");
    });
  }

  admit(input: { readonly root: ExecutionRoot; readonly operation: Extract<HostMutation, { op: "create" }> }): Promise<CatalogueAdmission> {
    const root = parseExecutionRoot(executionRootBytes(input.root));
    const operation = parseOperation(JSON.parse(JSON.stringify(input.operation)));
    return this.run<CatalogueAdmission>(async () => {
      const entries = await this.inspect();
      if (operation.op !== "create" || operation.workspaceId !== root.workspace.workspaceId || root.workspace.domain !== this.anchor.identity.domain || root.workspace.nodeId !== this.anchor.identity.nodeId || await realpath(operation.cwd) !== root.workspace.cwd)
        throw new Error("Managed creation differs from execution root");
      const payload = JSON.stringify(operation);
      const admission = this.db.prepare("SELECT payload FROM admissions WHERE id=?").get(operation.requestId);
      if (admission !== undefined) {
        const existing = entries.find(entry => entry.requestId === operation.requestId);
        if (admission.payload !== payload || existing === undefined || executionRootBytes(existing.root) !== executionRootBytes(root))
          throw new Error("Managed creation request conflicts with its original root");
        return { kind: "attached", entry: existing };
      }
      if (entries.some(entry => entry.root.rootId === root.rootId))
        throw new Error("Execution root identity already belongs to another workspace");
      if (this.db.prepare("SELECT id FROM workspaces WHERE id=?").get(operation.workspaceId) !== undefined)
        throw new Error("Existing workspace cannot become managed implicitly");
      if (this.db.prepare("SELECT id FROM workspaces LIMIT 1 OFFSET ?").get(MAX_WORKSPACES - 1) !== undefined)
        throw new Error("Host workspace capacity reached");
      const bytes = executionRootBytes(root);
      await this.roots.create(rootFile(operation.workspaceId), bytes);
      this.transaction(() => {
        this.db.prepare("INSERT INTO workspaces (id, cwd) VALUES (?, ?)").run(operation.workspaceId, root.workspace.cwd);
        this.db.prepare("INSERT INTO herdr_managed_workspaces VALUES (?, ?, ?, ?)").run(operation.workspaceId, root.rootId, bytes, operation.requestId);
        this.db.prepare("INSERT INTO admissions (id, payload) VALUES (?, ?)").run(operation.requestId, payload);
        return undefined;
      });
      return { kind: "created", entry: await this.entry(operation.workspaceId) };
    });
  }

  close(): Promise<void> {
    if (this.#work.kind === "closing") return this.#work.completion;
    const completion = this.#work.tail;
    this.#work = { kind: "closing", completion };
    return completion;
  }
}
