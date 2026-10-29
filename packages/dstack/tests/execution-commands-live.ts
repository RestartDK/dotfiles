import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { CommandDirectory } from "#command-store";
import { CommandRuntime } from "#command-runtime";
import { parseCommandCredentials, parseCommandEvidence, parseCommandReceipt, parseCommandSpec } from "#command-wire";
import { ExecutionJournal } from "#execution-journal";
import { ExecutionCommands } from "#execution-commands";

const helper = process.env.DSTACK_COMMAND_HELPER_TEST, node = process.env.DSTACK_TEST_NODE;
if (helper === undefined || !helper.startsWith("/nix/store/") || node === undefined || !node.startsWith("/nix/store/"))
  throw new Error("Explicit packaged helper and production Node required");
const audit = join(await realpath(process.cwd()), ".audit");
await mkdir(audit, { recursive: true, mode: 0o700 });
const path = await mkdtemp(join(audit, "owned-"));
const cwd = join(path, "workspace"), evidence = join(path, "evidence"), marker = join(cwd, "effect.txt"), finish = join(cwd, "finish.txt");
await mkdir(cwd, { mode: 0o700 }); await mkdir(evidence, { mode: 0o700 });
const database = join(path, "host.sqlite"), file = await open(database, "wx", 0o600); await file.close();
const lockCommand = { file: process.env.DSTACK_FLOCK ?? "/run/current-system/sw/bin/flock", args: [] };
const root = { version: 1, rootId: randomUUID(), token: randomBytes(32).toString("hex"), workspace: { domain: "personal", nodeId: "owned-fixture", workspaceId: "owned", cwd } } satisfies Parameters<typeof ExecutionJournal.initialize>[0]["root"];
const runtime = new CommandRuntime({ helper, systemdRun: "/run/current-system/sw/bin/systemd-run", systemctl: "/run/current-system/sw/bin/systemctl", busctl: "/run/current-system/sw/bin/busctl", launcher: [], environmentNames: ["PATH", "HOME", "LANG"], credentials: parseCommandCredentials(JSON.stringify({ uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.() })) });
const sourceBootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
type Resources = { readonly db: DatabaseSync; readonly lease: Awaited<ReturnType<typeof CommandDirectory.own>>; readonly journal: ExecutionJournal; readonly commands: ExecutionCommands };
const resources: { current: Resources | undefined } = { current: undefined };

async function acquire(mode: "new" | "existing"): Promise<Resources> {
  const db = new DatabaseSync(database); db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  let lease: Resources["lease"] | undefined, journal: ExecutionJournal | undefined;
  try {
    lease = await CommandDirectory.own({ path: evidence, lockCommand });
    journal = await ExecutionJournal[mode === "new" ? "initialize" : "open"]({ db, directory: lease.directory, root, maxRecords: 32 });
    const commands = await ExecutionCommands.open({ journal, directory: await lease.directory.child("commands", mode), runtime, sourceBootId });
    return { db, lease, journal, commands };
  } catch (error) {
    const errors: unknown[] = [error];
    try { await journal?.close(); } catch (failure) { errors.push(failure); }
    try { db.close(); } catch (failure) { errors.push(failure); }
    try { await lease?.close(); } catch (failure) { errors.push(failure); }
    throw new AggregateError(errors, "Owned command fixture acquire failed");
  }
}

async function close(): Promise<void> {
  const active = resources.current; resources.current = undefined;
  if (active === undefined) return;
  const errors: unknown[] = [];
  try { await active.commands.close(); } catch (error) { errors.push(error); }
  try { await active.journal.close(); } catch (error) { errors.push(error); }
  try { active.db.close(); } catch (error) { errors.push(error); }
  try { await active.lease.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "Owned command fixture close failed");
}

async function settle(commands: ExecutionCommands): Promise<void> {
  const deadline = performance.now() + 25000;
  while (performance.now() < deadline) {
    if ((await commands.adopt("once")).phase.kind === "adopted") return;
    await delay(25);
  }
  throw new Error("Owned command adoption deadline");
}

const failures: unknown[] = [];
let namespace: "not-requested" | "requested" | "released" = "not-requested";
try {
  resources.current = await acquire("new");
  const initial = resources.current;
  const script = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'once',{flag:'wx',mode:384});const t=setInterval(()=>{if(fs.existsSync(process.argv[2]))clearInterval(t);},20);";
  const input = { intentId: "once", argv: [node, "-e", script, marker, finish], timeoutSeconds: 15 };
  const authorized = await initial.commands.authorize(input);
  assert.equal((await initial.commands.describe("once")).grant, "live");
  await assert.rejects(initial.commands.release("once"), /requires durable adoption/);
  namespace = "requested";
  const started = await initial.commands.start("once", { taskKey: "fixture-task", conversationKey: "fixture-conversation", callId: "first-call" });
  assert.equal(started.phase.kind, "activated");
  assert.equal((await initial.commands.describe("once")).grant, "consumed");
  if (started.phase.kind !== "activated") throw new Error("Original activation required");
  const original = parseCommandEvidence(started.phase.activation.evidenceJson);
  const spec = parseCommandSpec(authorized.authorization.specJson);
  const jobs = await initial.lease.directory.child("commands", "existing");
  const job = await jobs.child(spec.executionId, "existing");
  const attached = await initial.commands.start("once", { taskKey: "second-task", conversationKey: "fixture-conversation", callId: "second-call" });
  assert.deepEqual(attached, started);
  assert.equal((await initial.journal.snapshot()).records.length, 3);
  await assert.rejects(initial.commands.authorize({ ...input, argv: [node, "-e", "throw Error('changed')"] }), /conflicts/);
  await close();
  const detached = await runtime.inspect({ directory: job, spec, digest: authorized.authorization.specSha256, evidence: original });
  assert.equal(detached.containment.kind, "active");
  assert.equal(detached.outcome.kind, "unobserved");
  await writeFile(finish, "finish", { flag: "wx", mode: 0o600 });
  resources.current = await acquire("existing");
  const recovered = resources.current;
  assert.equal((await recovered.commands.start("once", { taskKey: "third-task", conversationKey: "fixture-conversation", callId: "third-call" })).phase.kind, "activated");
  await settle(recovered.commands);
  const adopted = await recovered.commands.describe("once");
  assert.equal(adopted.command.phase.kind, "adopted");
  if (adopted.command.phase.kind !== "adopted") throw new Error("Adopted result required");
  const receipt = parseCommandReceipt(adopted.command.phase.adoption.receiptJson);
  assert.equal(receipt.outcome.kind, "exit");
  if (receipt.outcome.kind !== "exit") throw new Error("Normal exit receipt required");
  assert.equal(receipt.outcome.code, 0);
  assert.equal(receipt.evidence.activation.invocationId, original.activation.invocationId);
  await recovered.commands.release("once");
  namespace = "released";
  const cleaned = spawnSync(runtime.options.systemctl, ["--user", "show", spec.unit, "--property=NFileDescriptorStore", "--value"], { encoding: "utf8", timeout: 5000 });
  assert.equal(cleaned.stdout.trim(), "0", "Original namespace custody must be released");
  assert.equal((await recovered.commands.start("once", { taskKey: "settled-task", conversationKey: "fixture-conversation", callId: "settled-call" })).phase.kind, "adopted");
  assert.equal(await readFile(marker, "utf8"), "once");
  const snapshot = await recovered.journal.snapshot();
  assert.equal(snapshot.records.filter(record => record.event.kind === "command.attempted").length, 1);
  assert.equal(snapshot.records.length, 4);
  const result = { path, helper, verdict: "owned-command-component-only", originalInvocationId: original.activation.invocationId, oneAttemptAcrossDistinctSdkCalls: true, allBackendResourcesClosedWhileActive: true, receiptAdoptedAfterResourceReopen: true, namespaceReleasedAfterDurableAdoption: true, sdkProvenanceSynthetic: true, actualProcessKill: false, modelCommandToolRegistered: false, hostIntegrated: false };
  await writeFile(join(path, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { failures.push(error); }
if (failures.length) {
  try { await writeFile(finish, "finish", { mode: 0o600 }); } catch (error) { failures.push(error); }
  try {
    resources.current ??= await acquire("existing");
    const active = resources.current;
    const command = (await active.commands.describe("once")).command;
    if (namespace === "requested") {
      if (command.phase.kind === "activated") await settle(active.commands);
      const settled = (await active.commands.describe("once")).command;
      if (settled.phase.kind === "adopted") {
        await active.commands.release("once");
        namespace = "released";
      }
    }
  } catch (error) { failures.push(error); }
}
try { await close(); } catch (error) { failures.push(error); }
if (failures.length) throw new AggregateError(failures, `Owned command proof or cleanup failed; preserve ${path}`);
