import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CommandDirectory } from '#command-store';
import { ExecutionJournal } from '#execution-journal';
import { executionDigest, type ExecutionRoot, type ExecutionEvent } from '#execution-wire';

const path = await mkdtemp(join(tmpdir(), 'dstack-journal-'));
await mkdir(join(path, 'evidence'), { mode: 0o700 });
const file = await open(join(path, 'host.sqlite'), 'wx', 0o600); await file.close();
const db = new DatabaseSync(join(path, 'host.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
const owner = await CommandDirectory.own({ path: join(path, 'evidence'), lockCommand: { file: process.env.DSTACK_FLOCK || 'flock', args: [] } });
const marker = { version: 1, rootId: randomUUID(), token: randomBytes(32).toString('hex'), workspace: { domain: 'personal', nodeId: 'journal-proof', workspaceId: 'synthetic', cwd: process.cwd() } } satisfies ExecutionRoot;
const options = { db, directory: owner.directory, root: marker, maxRecords: 8 };
const journals: ExecutionJournal[] = [];
let primary: { kind: 'clear' } | { kind: 'failed'; error: unknown } = { kind: 'clear' };
async function driftAfterPublish(target: CommandDirectory, entry: string, operation: () => Promise<unknown>): Promise<void> {
  const original = CommandDirectory.prototype.create;
  CommandDirectory.prototype.create = async function (this: CommandDirectory, name, bytes) {
    await original.call(this, name, bytes);
    if (this.path === target.path && name === entry) db.exec('PRAGMA synchronous=NORMAL;');
  };
  try { await assert.rejects(operation(), /FULL/); }
  finally { CommandDirectory.prototype.create = original; db.exec('PRAGMA synchronous=FULL;'); }
}
try {
  const journal = await ExecutionJournal.initialize(options); journals.push(journal);
  assert.equal((await journal.snapshot()).records.length, 0);
  await assert.rejects(ExecutionJournal.initialize(options), /already exists/);
  const start = { kind: 'file.started', effectId: executionDigest('effect-1'), tool: 'write', path: join(process.cwd(), 'synthetic-never-written'), argumentsSha256: executionDigest('synthetic'), sdk: { taskKey: 'synthetic-task', conversationKey: 'synthetic-conversation', callId: 'synthetic-call' } } satisfies ExecutionEvent;
  const appended = await Promise.all([journal.append(start), journal.append({ kind: 'file.adopted', effectId: start.effectId })]);
  assert.deepEqual(appended.map(entry => entry.sequence), [1, 2]);
  const pending = journal.append({ ...start, effectId: executionDigest('effect-2'), sdk: { ...start.sdk, taskKey: 'synthetic-task-2', callId: 'synthetic-call-2' } });
  const closing = journal.close(); assert.equal(journal.close(), closing);
  await assert.rejects(journal.snapshot(), /closed/);
  assert.equal((await pending).sequence, 3); await closing;
  const reopened = await ExecutionJournal.open(options); journals.push(reopened);
  const before = await reopened.snapshot(); assert.equal(before.head.sequence, 3);
  const directory = await owner.directory.child('events', 'existing');
  const quarantine = await owner.directory.child('quarantine', 'new');
  const names = (await readdir(directory.path)).sort();
  const third = names.at(2); assert(third !== undefined);
  await rename(join(directory.path, third), join(quarantine.path, 'missing-record.json'));
  await assert.rejects(reopened.snapshot(), /missing or orphaned/);
  await rename(join(quarantine.path, 'missing-record.json'), join(directory.path, third));
  db.prepare('UPDATE herdr_execution_records SET root_id=? WHERE root_id=? AND sequence=3').run('quarantined', marker.rootId);
  await assert.rejects(reopened.snapshot(), /history missing/);
  db.prepare('UPDATE herdr_execution_records SET root_id=? WHERE root_id=? AND sequence=3').run(marker.rootId, 'quarantined');
  const old = db.prepare('SELECT head_sequence, head_sha256 FROM herdr_execution_roots WHERE id=?').get(marker.rootId);
  const first = db.prepare('SELECT sha256 FROM herdr_execution_records WHERE root_id=? AND sequence=1').get(marker.rootId);
  assert(old !== undefined && typeof old.head_sequence === 'number' && typeof old.head_sha256 === 'string');
  assert(first !== undefined && typeof first.sha256 === 'string');
  db.prepare('UPDATE herdr_execution_roots SET head_sequence=1, head_sha256=? WHERE id=?').run(first.sha256, marker.rootId);
  await assert.rejects(reopened.snapshot(), /history missing/);
  db.prepare('UPDATE herdr_execution_roots SET head_sequence=?, head_sha256=? WHERE id=?').run(old.head_sequence, old.head_sha256, marker.rootId);
  await directory.create('orphan.json', '{}');
  await assert.rejects(reopened.snapshot(), /missing or orphaned/);
  await rename(join(directory.path, 'orphan.json'), join(quarantine.path, 'orphan.json'));
  assert.deepEqual(await reopened.snapshot(), before);
  const limited = await ExecutionJournal.open({ ...options, maxRecords: 3 }); journals.push(limited);
  await assert.rejects(limited.append({ kind: 'file.adopted', effectId: executionDigest('effect-2') }), /capacity reached/);
  const changes = db.prepare('SELECT total_changes() AS changes').get();
  assert(changes !== undefined && typeof changes.changes === 'number');
  await reopened.snapshot();
  const afterRead = db.prepare('SELECT total_changes() AS changes').get();
  assert(afterRead !== undefined && typeof afterRead.changes === 'number');
  assert.equal(afterRead.changes, changes.changes);
  db.exec('PRAGMA synchronous=NORMAL;');
  try { await assert.rejects(reopened.append({ kind: 'file.adopted', effectId: executionDigest('effect-2') }), /FULL/); }
  finally { db.exec('PRAGMA synchronous=FULL;'); }
  db.exec('PRAGMA journal_mode=DELETE;');
  try { await assert.rejects(reopened.append({ kind: 'file.adopted', effectId: executionDigest('effect-2') }), /WAL/); }
  finally { db.exec('PRAGMA journal_mode=WAL;'); }
  assert.deepEqual(await reopened.snapshot(), before);
  await driftAfterPublish(directory, 'event-0000000000000004.json', () => reopened.append({ kind: 'file.adopted', effectId: executionDigest('effect-2') }));
  await assert.rejects(reopened.snapshot(), /missing or orphaned/);
  await rename(join(directory.path, 'event-0000000000000004.json'), join(quarantine.path, 'late-policy-drift.json'));
  assert.deepEqual(await reopened.snapshot(), before);
  const initialization = await owner.directory.child('policy-root', 'new');
  const initializationOptions = { ...options, directory: initialization, root: { ...marker, rootId: randomUUID(), workspace: { ...marker.workspace, workspaceId: 'policy' } } };
  await driftAfterPublish(initialization, 'execution.json', () => ExecutionJournal.initialize(initializationOptions));
  assert.equal(db.prepare('SELECT id FROM herdr_execution_roots WHERE id=?').get(initializationOptions.root.rootId), undefined);
  assert.notEqual(await initialization.read('execution.json', 32768), undefined);
  await assert.rejects(ExecutionJournal.open(initializationOptions), /root missing/);
  const partial = await owner.directory.child('partial-root', 'new');
  const partialEvents = await partial.child('events', 'new');
  await partialEvents.create('preserved.json', 'inspection-required');
  const partialOptions = { ...options, directory: partial, root: { ...marker, rootId: randomUUID(), workspace: { ...marker.workspace, workspaceId: 'partial' } } };
  await assert.rejects(ExecutionJournal.initialize(partialOptions), /EEXIST/);
  await assert.rejects(ExecutionJournal.open(partialOptions), /root missing/);
  assert.equal(await partialEvents.read('preserved.json', 64), 'inspection-required');
  await writeFile(join(path, 'result.json'), JSON.stringify({ verdict: 'paired-journal-component-only', records: 3, parallelOrdering: true, closeJoined: true, sqliteRecordLossRefused: true, sqliteHeadRollbackRefused: true, externalRecordLossRefused: true, orphanRefused: true, capacityRefused: true, snapshotDidNotWriteSqlite: true, sqlitePolicyChangesRefused: true, latePolicyDriftRefusedBeforeSqliteMutation: true, partialInitializationRefusedWithoutDeletingEvidence: true, semanticOwnership: false, harnessOpened: false, businessProgramRan: false }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ event: 'pass', proof: 'execution-journal', path, verdict: 'paired-journal-component-only' }));
} catch (error) { primary = { kind: 'failed', error }; }
const cleanup: unknown[] = [];
for (const journal of journals) { try { await journal.close(); } catch (error) { cleanup.push(error); } }
try { db.close(); } catch (error) { cleanup.push(error); }
try { await owner.close(); } catch (error) { cleanup.push(error); }
if (primary.kind === 'failed' || cleanup.length) throw new AggregateError([...(primary.kind === 'failed' ? [primary.error] : []), ...cleanup], 'Journal proof or cleanup failed');
