import type { DatabaseSync } from "node:sqlite";

export function requireDurableSqlite(db: DatabaseSync, owner: "Execution journal" | "Execution catalogue" = "Execution journal"): void {
  const mode = db.prepare("PRAGMA journal_mode").get();
  if (mode?.journal_mode !== "wal") throw new Error(`${owner} requires WAL SQLite`);
  const durability = db.prepare("PRAGMA synchronous").get();
  if (durability?.synchronous !== 2 && durability?.synchronous !== 3)
    throw new Error(`${owner} requires FULL SQLite synchronization`);
}
