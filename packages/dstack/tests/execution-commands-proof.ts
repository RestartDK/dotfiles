import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CommandDirectory } from "#command-store";
import { CommandRuntime, CommandSource } from "#command-runtime";
import { parseCommandCredentials, parseCommandSpec } from "#command-wire";
import { ExecutionJournal } from "#execution-journal";
import { ExecutionCommands } from "#execution-commands";

const path = await mkdtemp(join(tmpdir(), "dstack-command-owner-"));
const cwd = join(path, "workspace"), evidence = join(path, "evidence"), quarantine = join(path, "quarantine");
await Promise.all([cwd, evidence, quarantine].map(directory => mkdir(directory, { mode: 0o700 })));
const file = await open(join(path, "host.sqlite"), "wx", 0o600); await file.close();
const db = new DatabaseSync(join(path, "host.sqlite"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
const lease = await CommandDirectory.own({ path: evidence, lockCommand: { file: process.env.DSTACK_FLOCK ?? "flock", args: [] } });
const jobs = await lease.directory.child("commands", "new");
const credentials = parseCommandCredentials(JSON.stringify({ uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.() }));
const runtime = new CommandRuntime({
  helper: "/non-executed-helper", systemdRun: "/non-executed-systemd-run", systemctl: "/non-executed-systemctl", busctl: "/non-executed-busctl",
  credentials, launcher: [], environmentNames: ["DSTACK_COMMAND_PROOF_VALUE"],
});
const sourceBootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
const root = { version: 1, rootId: randomUUID(), token: randomBytes(32).toString("hex"), workspace: { domain: "personal", nodeId: "owner-fixture", workspaceId: "commands", cwd } } satisfies Parameters<typeof ExecutionJournal.initialize>[0]["root"];
let journal: ExecutionJournal | undefined, owner: ExecutionCommands | undefined;
const failures: unknown[] = [];
const previousValue = process.env.DSTACK_COMMAND_PROOF_VALUE;
const fixtureValue = `fixture-value-never-persist-${randomUUID()}`;
process.env.DSTACK_COMMAND_PROOF_VALUE = fixtureValue;
try {
  journal = await ExecutionJournal.initialize({ db, directory: lease.directory, root, maxRecords: 32 });
  const options = { journal, directory: jobs, runtime, sourceBootId };
  owner = await ExecutionCommands.open(options);
  await assert.rejects(ExecutionCommands.open(options), /already has a command owner/);
  const descriptors = async () => (await readdir("/proc/self/fd")).length;
  const baseline = await descriptors();
  await assert.rejects(owner.authorize({ intentId: " \t", argv: ["/not-run"], timeoutSeconds: 5 }), /Invalid command/);
  assert.equal((await journal.snapshot()).records.length, 0);
  assert.equal(await descriptors(), baseline);
  const argv = ["/not-run", "approved"];
  const pending = owner.authorize({ intentId: "alpha", argv, timeoutSeconds: 5 });
  argv[1] = "changed-after-admission";
  const alpha = await pending;
  assert.deepEqual(parseCommandSpec(alpha.authorization.specJson).argv, ["/not-run", "approved"]);
  assert.equal((await owner.describe("alpha")).grant, "live");
  assert.equal(await descriptors(), baseline + 5);
  const duplicate = await owner.authorize({ intentId: "alpha", argv: ["/not-run", "approved"], timeoutSeconds: 5 });
  assert.equal(duplicate.authorization.specJson, alpha.authorization.specJson);
  assert.equal((await journal.snapshot()).records.length, 1);
  assert.equal(await descriptors(), baseline + 5);
  await assert.rejects(owner.authorize({ intentId: "alpha", argv: ["/not-run", "different"], timeoutSeconds: 5 }), /conflicts/);
  await assert.rejects(owner.reconcile({ intentId: "alpha", actor: "fixture", reference: "unattempted", containment: { kind: "trusted-offline", reference: "no-attempt" } }), /no unresolved command attempt/);
  assert.equal((await owner.describe("alpha")).command.phase.kind, "authorized");
  assert.equal((await owner.describe("alpha")).grant, "live");
  assert.equal(await descriptors(), baseline + 5);
  await assert.rejects(owner.start("alpha", { taskKey: "", conversationKey: "fixture", callId: "invalid" }), /Invalid execution/);
  assert.equal((await journal.snapshot()).records.length, 1);
  assert.equal((await owner.describe("alpha")).grant, "live");
  await owner.cancel("alpha");
  await owner.cancel("alpha");
  assert.equal((await owner.describe("alpha")).grant, "revoked");
  assert.equal(await descriptors(), baseline);
  assert.equal((await journal.snapshot()).records.length, 2);
  await assert.rejects(owner.start("alpha", { taskKey: "fixture-task", conversationKey: "fixture", callId: "revoked" }), /expired or revoked/);
  const beta = await owner.authorize({ intentId: "beta", argv: ["/not-run"], timeoutSeconds: 5 });
  assert.equal(await descriptors(), baseline + 5);
  const closing = owner.close();
  assert.equal(owner.close(), closing);
  await assert.rejects(owner.describe("beta"), /closed/);
  await closing;
  assert.equal(await descriptors(), baseline);
  owner = await ExecutionCommands.open(options);
  assert.equal((await owner.describe("beta")).grant, "expired");
  assert.equal((await owner.authorize({ intentId: "beta", argv: ["/not-run"], timeoutSeconds: 5 })).authorization.specJson, beta.authorization.specJson);
  assert.equal(await descriptors(), baseline);
  await assert.rejects(owner.start("beta", { taskKey: "fixture-task", conversationKey: "fixture", callId: "expired" }), /expired or revoked/);
  const gamma = await owner.authorize({ intentId: "gamma", argv: ["/not-run"], timeoutSeconds: 5 });
  assert.notEqual(gamma.authorization.captureEpoch, beta.authorization.captureEpoch);
  assert.deepEqual(parseCommandSpec(gamma.authorization.specJson).context, parseCommandSpec(beta.authorization.specJson).context);
  assert.equal((await owner.describe("beta")).grant, "expired");
  assert.equal((await owner.describe("gamma")).grant, "live");
  assert.equal(await descriptors(), baseline + 5);
  const gammaDirectory = await jobs.child(parseCommandSpec(gamma.authorization.specJson).executionId, "existing");
  await rename(join(gammaDirectory.path, "spec.json"), join(quarantine, "gamma-spec.json"));
  await assert.rejects(owner.snapshot(), /ENOENT/);
  await rename(join(quarantine, "gamma-spec.json"), join(gammaDirectory.path, "spec.json"));
  await writeFile(join(gammaDirectory.path, "ready.json"), "{}", { flag: "wx", mode: 0o600 });
  await assert.rejects(owner.snapshot(), /unexpected execution evidence/);
  await rename(join(gammaDirectory.path, "ready.json"), join(quarantine, "injected-ready.json"));
  const orphan = await jobs.child("orphan", "new");
  await assert.rejects(owner.snapshot(), /missing or orphaned/);
  await owner.close();
  await assert.rejects(ExecutionCommands.open(options), /missing or orphaned/);
  await rename(orphan.path, join(quarantine, "orphan"));
  owner = await ExecutionCommands.open(options);
  assert.equal((await owner.describe("gamma")).grant, "expired");
  const snapshot = await journal.snapshot();
  assert.equal(JSON.stringify(snapshot.records).includes(fixtureValue), false);
  assert.equal(snapshot.records.length, 4);
  assert.equal(await descriptors(), baseline);
  await owner.authorize({ intentId: "failed-close", argv: ["/not-run"], timeoutSeconds: 5 });
  const originalClose = CommandSource.prototype.close;
  let captured: CommandSource | undefined, rejected: Promise<void> | undefined;
  try {
    CommandSource.prototype.close = function (this: CommandSource): Promise<void> {
      captured = this;
      rejected ??= Promise.reject(new Error("Injected memoized source cleanup failure"));
      return rejected;
    };
    await assert.rejects(owner.cancel("failed-close"), /Injected memoized source cleanup failure/);
    assert.equal((await owner.describe("failed-close")).grant, "revoked");
    const closing = owner.close();
    assert.equal(owner.close(), closing);
    await assert.rejects(closing, /Command grant cleanup failed/);
    assert.equal(await descriptors(), baseline + 5);
  } finally {
    CommandSource.prototype.close = originalClose;
    if (captured !== undefined) await originalClose.call(captured);
  }
  owner = await ExecutionCommands.open(options);
  assert.equal((await owner.describe("failed-close")).grant, "revoked");
  assert.equal(await descriptors(), baseline);
  assert.equal((await journal.snapshot()).records.length, 6);
  const result = { path, verdict: "trusted-command-grant-component-only", unattemptedReconciliationRefused: true, failedSourceCleanupNotReportedClean: true, actualSourceDescriptorsPerGrant: 5, immutableInputAndDuplicateRefused: true, revokedAndLostGrantsRefused: true, explicitNewEpochRequired: true, orphanAndUnexpectedEvidenceRefused: true, environmentValuesNotPersisted: true, commandRan: false, sdkProvenanceSynthetic: true, hostIntegrated: false };
  await writeFile(join(path, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { failures.push(error); }
if (previousValue === undefined) delete process.env.DSTACK_COMMAND_PROOF_VALUE;
else process.env.DSTACK_COMMAND_PROOF_VALUE = previousValue;
try { await owner?.close(); } catch (error) { failures.push(error); }
try { await journal?.close(); } catch (error) { failures.push(error); }
try { db.close(); } catch (error) { failures.push(error); }
try { await lease.close(); } catch (error) { failures.push(error); }
if (failures.length) throw new AggregateError(failures, "Command grant proof or cleanup failed");
