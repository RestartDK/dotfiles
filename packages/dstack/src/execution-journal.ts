import { readdir } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { CommandDirectory } from "./command-store.js";
import { reduceExecutionRecords, type ExecutionState } from "./execution-domain.js";
import { requireDurableSqlite } from "./execution-sqlite.js";
import {
  executionDigest, executionRootBytes, MAX_EXECUTION_RECORD_BYTES,
  parseExecutionEvent, parseExecutionRecord, parseExecutionRoot,
  type ExecutionEvent, type ExecutionRecord, type ExecutionRoot,
} from "./execution-wire.js";

type Work = { readonly kind: "open"; tail: Promise<void> } | { readonly kind: "closing"; readonly completion: Promise<void> };
export type ExecutionSnapshot = {
  readonly root: ExecutionRoot;
  readonly state: ExecutionState;
  readonly records: readonly ExecutionRecord[];
  readonly head: { readonly sequence: number; readonly sha256: string };
};
type Options = {
  readonly db: DatabaseSync;
  readonly directory: CommandDirectory;
  readonly root: ExecutionRoot;
  readonly maxRecords: number;
};

function fileName(sequence: number): string { return `event-${String(sequence).padStart(16, "0")}.json`; }

function options(input: Options): ExecutionRoot {
  if (!Number.isSafeInteger(input.maxRecords) || input.maxRecords < 1 || input.maxRecords >= Number.MAX_SAFE_INTEGER)
    throw new Error("Invalid execution journal capacity");
  requireDurableSqlite(input.db);
  const root = parseExecutionRoot(executionRootBytes(input.root));
  Object.freeze(root.workspace);
  return Object.freeze(root);
}

export class ExecutionJournal {
  #work: Work = { kind: "open", tail: Promise.resolve() };

  private constructor(
    readonly root: ExecutionRoot,
    private readonly db: DatabaseSync,
    private readonly directory: CommandDirectory,
    private readonly recordsDirectory: CommandDirectory,
    private readonly maxRecords: number,
  ) {}

  static async initialize(input: Options): Promise<ExecutionJournal> {
    const root = options(input);
    input.db.exec(`
      CREATE TABLE IF NOT EXISTS herdr_execution_roots (
        id TEXT PRIMARY KEY, root_json TEXT NOT NULL, head_sequence INTEGER NOT NULL, head_sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS herdr_execution_records (
        root_id TEXT NOT NULL, sequence INTEGER NOT NULL, sha256 TEXT NOT NULL, record_json TEXT NOT NULL,
        PRIMARY KEY(root_id, sequence));`);
    if (input.db.prepare("SELECT id FROM herdr_execution_roots WHERE id=?").get(root.rootId) !== undefined)
      throw new Error("Execution root already exists");
    const records = await input.directory.child("events", "new");
    const bytes = executionRootBytes(root);
    await input.directory.create("execution.json", bytes);
    requireDurableSqlite(input.db);
    input.db.prepare("INSERT INTO herdr_execution_roots VALUES (?, ?, 0, ?)").run(root.rootId, bytes, executionDigest(bytes));
    const journal = new ExecutionJournal(root, input.db, input.directory, records, input.maxRecords);
    await journal.snapshot();
    return journal;
  }

  static async open(input: Options): Promise<ExecutionJournal> {
    const root = options(input);
    const records = await input.directory.child("events", "existing");
    const journal = new ExecutionJournal(root, input.db, input.directory, records, input.maxRecords);
    await journal.snapshot();
    return journal;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#work.kind !== "open") return Promise.reject(new Error("Execution journal is closed"));
    const completion = this.#work.tail.then(operation);
    this.#work.tail = completion.then(() => undefined, () => undefined);
    return completion;
  }

  private async inspect(): Promise<ExecutionSnapshot> {
    requireDurableSqlite(this.db);
    const rootBytes = executionRootBytes(this.root);
    const root = this.db.prepare("SELECT root_json, head_sequence, head_sha256 FROM herdr_execution_roots WHERE id=?").get(this.root.rootId);
    if (root === undefined || root.root_json !== rootBytes || typeof root.head_sequence !== "number"
      || !Number.isSafeInteger(root.head_sequence) || root.head_sequence < 0 || root.head_sequence > this.maxRecords
      || typeof root.head_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(root.head_sha256))
      throw new Error("Execution SQLite root missing, changed or unavailable");
    if (await this.directory.read("execution.json", MAX_EXECUTION_RECORD_BYTES) !== rootBytes)
      throw new Error("External execution root missing or changed");
    const rows = this.db.prepare("SELECT sequence, sha256, record_json FROM herdr_execution_records WHERE root_id=? ORDER BY sequence LIMIT ?")
      .all(this.root.rootId, this.maxRecords + 1);
    if (rows.length !== root.head_sequence) throw new Error("Execution journal history missing or beyond capacity");
    const names = await readdir(this.recordsDirectory.path);
    if (names.length !== rows.length) throw new Error("Execution journal external history is missing or orphaned");
    const expectedNames = new Set<string>();
    let previous = executionDigest(rootBytes);
    const records: ExecutionRecord[] = [];
    for (const [index, row] of rows.entries()) {
      const sequence = index + 1;
      if (row.sequence !== sequence || typeof row.record_json !== "string" || typeof row.sha256 !== "string"
        || Buffer.byteLength(row.record_json) > MAX_EXECUTION_RECORD_BYTES || executionDigest(row.record_json) !== row.sha256)
        throw new Error("Execution SQLite record missing or changed");
      const entry = parseExecutionRecord(row.record_json, this.root);
      if (entry.sequence !== sequence || entry.previousSha256 !== previous)
        throw new Error("Execution journal lineage changed");
      const name = fileName(sequence);
      expectedNames.add(name);
      if (await this.recordsDirectory.read(name, MAX_EXECUTION_RECORD_BYTES) !== row.record_json)
        throw new Error("External execution record missing or changed");
      previous = row.sha256;
      records.push(entry);
    }
    if (names.some(name => !expectedNames.has(name)) || previous !== root.head_sha256)
      throw new Error("Execution journal head or external history changed");
    return { root: this.root, state: reduceExecutionRecords(records), records, head: { sequence: records.length, sha256: previous } };
  }

  snapshot(): Promise<ExecutionSnapshot> { return this.run(() => this.inspect()); }

  append(event: ExecutionEvent): Promise<ExecutionRecord> {
    return this.run(async () => {
      const current = await this.inspect();
      if (current.head.sequence >= this.maxRecords) throw new Error("Execution journal capacity reached");
      const parsed = parseExecutionEvent(JSON.stringify(event), this.root);
      const bytes = JSON.stringify({
        version: 1, rootId: this.root.rootId, sequence: current.head.sequence + 1,
        previousSha256: current.head.sha256, event: parsed,
      });
      const entry = parseExecutionRecord(bytes, this.root);
      reduceExecutionRecords([...current.records, entry]);
      const sha256 = executionDigest(bytes);
      await this.recordsDirectory.create(fileName(entry.sequence), bytes);
      requireDurableSqlite(this.db);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("INSERT INTO herdr_execution_records VALUES (?, ?, ?, ?)").run(this.root.rootId, entry.sequence, sha256, bytes);
        const changed = this.db.prepare("UPDATE herdr_execution_roots SET head_sequence=?, head_sha256=? WHERE id=? AND head_sequence=? AND head_sha256=?")
          .run(entry.sequence, sha256, this.root.rootId, current.head.sequence, current.head.sha256);
        if (Number(changed.changes) !== 1) throw new Error("Execution SQLite head changed during append");
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); }
        catch (rollback) { throw new AggregateError([error, rollback], "Execution journal transaction failed"); }
        throw error;
      }
      return entry;
    });
  }

  close(): Promise<void> {
    if (this.#work.kind === "closing") return this.#work.completion;
    const completion = this.#work.tail;
    this.#work = { kind: "closing", completion };
    return completion;
  }
}
