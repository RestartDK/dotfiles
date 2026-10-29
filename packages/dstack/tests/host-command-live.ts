import assert from "node:assert/strict";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { parseCommandEvidence, parseCommandSpec } from "#command-wire";

const node = process.env.DSTACK_TEST_NODE, helper = process.env.DSTACK_COMMAND_HELPER;
if (node === undefined || !node.startsWith("/nix/store/") || helper === undefined || !helper.startsWith("/nix/store/"))
  throw new Error("Explicit packaged production Node and command helper required");
const audit = join(await realpath(process.cwd()), ".audit"); await mkdir(audit, { recursive: true, mode: 0o700 });
const path = await mkdtemp(join(audit, "host-command-"));
const cwd = join(path, "workspace"); await mkdir(cwd, { mode: 0o700 });
const stateRoot = join(path, "state"), marker = join(cwd, "effect.txt"), finish = join(cwd, "finish.txt"), configPath = join(path, "config.json");
await writeFile(configPath, JSON.stringify({ identity: { deploymentId: "host-command-proof", domain: "personal", nodeId: "fixture" }, stateRoot, model: { provider: "host-command-fixture", modelId: "idle" }, thinkingLevel: "off", authPath: join(path, "auth.json"), modelsPath: join(path, "models.json"), execution: { mode: "durable", maxRecords: 256 } }), { flag: "wx", mode: 0o600 });
function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value)); return Object.fromEntries(Object.entries(value));
}
type Backend = {
  readonly child: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  call(request: object): Promise<unknown>;
  event(name: string): Promise<Record<string, unknown>>;
};
async function start(mode: "hold-launch" | "hold-before-launch" | "hold-scheduler" | "normal"): Promise<Backend> {
  const child = fork(fileURLToPath(new URL("./host-command-fixture.js", import.meta.url)), [configPath, mode], { execPath: node, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = "", next = 0;
  child.stderr?.on("data", (chunk: Buffer) => { if (errors.length < 65536) errors += chunk.toString(); });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; deadline: NodeJS.Timeout }>();
  const observed = new Map<string, Record<string, unknown>>();
  const events = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; deadline: NodeJS.Timeout }>();
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const failure = new Error(`Owned backend exited (${code}, ${signal}): ${errors}`);
      for (const wait of pending.values()) { clearTimeout(wait.deadline); wait.reject(failure); }
      pending.clear();
      for (const wait of events.values()) { clearTimeout(wait.deadline); wait.reject(failure); }
      events.clear();
      resolve({ code, signal });
    });
  });
  child.on("message", (message: unknown) => {
    const record = object(message);
    if (typeof record.event === "string") {
      observed.set(record.event, record);
      const wait = events.get(record.event);
      if (wait !== undefined) { clearTimeout(wait.deadline); events.delete(record.event); wait.resolve(record); }
    } else if (typeof record.id === "number") {
      const wait = pending.get(record.id);
      if (wait !== undefined) {
        clearTimeout(wait.deadline); pending.delete(record.id);
        if (record.error !== undefined) wait.reject(new Error("Trusted fixture request refused")); else wait.resolve(record.value);
      }
    }
  });
  const backend: Backend = {
    child, exit,
    call(request) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { pending.delete(id); reject(new Error("Owned backend request deadline")); }, 15000);
        pending.set(id, { resolve, reject, deadline }); child.send({ id, ...request });
      });
    },
    event(name) {
      const existing = observed.get(name); if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { events.delete(name); reject(new Error(`Owned backend event deadline: ${name}`)); }, 15000);
        events.set(name, { resolve, reject, deadline });
      });
    },
  };
  try { await backend.event("ready"); return backend; }
  catch (error) { child.kill("SIGKILL"); await exit; throw error; }
}
let backend: Backend | undefined;
let namespaceRequested = false, unattemptedAuthorized = false;
const failures: unknown[] = [];
async function command(op: string, intentId = "once") {
  assert.ok(backend !== undefined); return backend.call({ command: { op, workspaceId: "coding", intentId } });
}
async function adopted(intentId = "once"): Promise<Record<string, unknown>> {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    const state = object(await command("adopt", intentId));
    if (object(state.phase).kind === "adopted") return state;
    await delay(25);
  }
  throw new Error("Composite command adoption deadline");
}
try {
  backend = await start("hold-launch");
  await backend.call({ operation: { op: "create", requestId: "create", workspaceId: "coding", cwd } });
  const script = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'once',{flag:'wx',mode:384});const t=setInterval(()=>{if(fs.existsSync(process.argv[2]))clearInterval(t);},20);";
  const authorization = { intentId: "once", argv: [node, "-e", script, marker, finish], timeoutSeconds: 15 };
  const authorized = object(await backend.call({ command: { op: "authorize", workspaceId: "coding", authorization } }));
  const specJson = object(authorized.authorization).specJson; assert.ok(typeof specJson === "string");
  const spec = parseCommandSpec(specJson);
  namespaceRequested = true;
  const task = object(await command("start"));
  assert.ok(typeof task.taskKey === "string" && typeof task.conversationKey === "string");
  const held = await backend.event("launch-held");
  assert.equal(held.executionId, spec.executionId);
  const db = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  let evidenceJson: string;
  try {
    const records = db.prepare("SELECT record_json FROM herdr_execution_records ORDER BY sequence").all();
    assert.equal(records.length, 3);
    const attempt = object(JSON.parse(String(records[1]?.record_json)));
    assert.deepEqual(object(attempt.event).sdk, { kind: "task", taskKey: task.taskKey, conversationKey: task.conversationKey });
    const activation = object(object(JSON.parse(String(records[2]?.record_json))).event);
    assert.ok(typeof activation.evidenceJson === "string"); evidenceJson = activation.evidenceJson;
  } finally { db.close(); }
  const original = parseCommandEvidence(evidenceJson);
  backend.child.kill("SIGKILL");
  assert.equal((await backend.exit).signal, "SIGKILL"); backend = undefined;
  await writeFile(finish, "finish", { flag: "wx", mode: 0o600 });
  backend = await start("normal");
  const attached = object(await command("start"));
  assert.equal(object(object(attached.command).phase).kind, "activated");
  await assert.rejects(backend.call({ command: { op: "authorize", workspaceId: "coding", authorization: { ...authorization, argv: [node, "-e", "throw Error('changed')"] } } }));
  const settled = await adopted();
  const adoption = object(object(settled.phase).adoption);
  const receiptJson = adoption.receiptJson; assert.ok(typeof receiptJson === "string");
  const receipt = object(JSON.parse(receiptJson));
  assert.equal(object(receipt.outcome).kind, "exit"); assert.equal(object(receipt.outcome).code, 0);
  assert.equal(object(object(receipt.evidence).activation).invocationId, original.activation.invocationId);
  await command("release"); namespaceRequested = false;
  const manager = process.env.DSTACK_SYSTEMCTL; assert.ok(manager !== undefined);
  const cleaned = spawnSync(manager, ["--user", "show", spec.unit, "--property=NFileDescriptorStore", "--value"], { encoding: "utf8", timeout: 5000 });
  assert.equal(cleaned.status, 0); assert.equal(cleaned.stdout.trim(), "0");
  assert.equal(await readFile(marker, "utf8"), "once");
  const verify = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  try {
    const records = verify.prepare("SELECT record_json FROM herdr_execution_records ORDER BY sequence").all();
    assert.equal(records.length, 4);
    assert.equal(records.filter(row => object(object(JSON.parse(String(row.record_json))).event).kind === "command.attempted").length, 1);
  } finally { verify.close(); }
  backend.child.disconnect(); assert.equal((await backend.exit).code, 0); backend = undefined;

  backend = await start("hold-scheduler");
  const forbidden = join(cwd, "must-not-run.txt");
  await backend.call({ command: { op: "authorize", workspaceId: "coding", authorization: { intentId: "unattempted", argv: [node, "-e", "require('node:fs').writeFileSync(process.argv[1],'replayed',{flag:'wx'})", forbidden], timeoutSeconds: 10 } } });
  unattemptedAuthorized = true;
  const pendingTask = object(await command("start", "unattempted"));
  const heldTasks = object(await backend.call({ tasks: true }));
  assert.equal(object(heldTasks.inspection).scheduling, "paused");
  assert.ok(Array.isArray(heldTasks.tasks));
  const heldTask = heldTasks.tasks.map(object).find(record => String(record.id) === pendingTask.taskKey);
  assert.ok(heldTask !== undefined); assert.equal(object(heldTask.state).status, "pending");
  const unattempted = object(await command("describe", "unattempted"));
  assert.equal(object(object(unattempted.command).phase).kind, "authorized");
  assert.equal(unattempted.grant, "live");
  backend.child.kill("SIGKILL"); assert.equal((await backend.exit).signal, "SIGKILL"); backend = undefined;
  backend = await start("normal");
  await assert.rejects(command("start", "unattempted"));
  const expired = object(await command("describe", "unattempted"));
  assert.equal(expired.grant, "expired"); assert.equal(object(object(expired.command).phase).kind, "authorized");
  const expiryDeadline = performance.now() + 10000;
  let terminal: Record<string, unknown> | undefined;
  while (performance.now() < expiryDeadline) {
    const view = object(await backend.call({ tasks: true })); assert.ok(Array.isArray(view.tasks));
    const current = view.tasks.map(object).find(record => String(record.id) === pendingTask.taskKey);
    if (current !== undefined && object(current.state).status === "terminal") { terminal = current; break; }
    await delay(20);
  }
  assert.ok(terminal !== undefined, "Recovered owned task must fault terminally on its lost live grant");
  const terminalState = object(terminal.state);
  assert.equal(object(terminalState.outcome).status, "faulted");
  assert.match(JSON.stringify(terminalState.outcome), /source grant is expired or revoked/);
  await assert.rejects(readFile(forbidden), { code: "ENOENT" });
  const noReplay = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  try {
    const rows = noReplay.prepare("SELECT record_json FROM herdr_execution_records ORDER BY sequence").all();
    assert.equal(rows.length, 5);
    assert.equal(rows.filter(row => object(object(JSON.parse(String(row.record_json))).event).kind === "command.attempted").length, 1);
  } finally { noReplay.close(); }
  await command("cancel", "unattempted");
  assert.equal(object(await command("describe", "unattempted")).grant, "revoked");
  unattemptedAuthorized = false;
  backend.child.disconnect(); assert.equal((await backend.exit).code, 0); backend = undefined;
  backend = await start("hold-before-launch");
  const neverLaunched = join(cwd, "must-not-launch.txt");
  await backend.call({ command: { op: "authorize", workspaceId: "coding", authorization: { intentId: "before-launch", argv: [node, "-e", "require('node:fs').writeFileSync(process.argv[1],'replayed',{flag:'wx'})", neverLaunched], timeoutSeconds: 10 } } });
  const beforeLaunchTask = object(await command("start", "before-launch"));
  assert.ok(typeof beforeLaunchTask.taskKey === "string" && typeof beforeLaunchTask.conversationKey === "string");
  const beforeLaunchHeld = await backend.event("before-launch-held");
  const beforeLaunch = object(await backend.call({ tasks: true }));
  assert.equal(beforeLaunch.providerCalls, 0);
  const attemptDb = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  try {
    const events = attemptDb.prepare("SELECT record_json FROM herdr_execution_records ORDER BY sequence").all().map(row => object(object(JSON.parse(String(row.record_json))).event)).filter(event => event.intentId === "before-launch" || (event.kind === "command.authorized" && typeof event.specJson === "string" && parseCommandSpec(event.specJson).intentId === "before-launch"));
    assert.deepEqual(events.map(event => event.kind), ["command.authorized", "command.attempted"]);
    const beforeSpecJson = events[0]?.specJson; assert.ok(typeof beforeSpecJson === "string");
    assert.equal(beforeLaunchHeld.executionId, parseCommandSpec(beforeSpecJson).executionId);
    assert.deepEqual(events[1]?.sdk, { kind: "task", taskKey: beforeLaunchTask.taskKey, conversationKey: beforeLaunchTask.conversationKey });
  } finally { attemptDb.close(); }
  backend.child.kill("SIGKILL"); assert.equal((await backend.exit).signal, "SIGKILL"); backend = undefined;
  backend = await start("normal");
  for (let i = 0; i < 2; i++) {
    const attached = object(await command("start", "before-launch"));
    assert.equal(object(object(attached.command).phase).kind, "attempted");
  }
  const uncertain = object(await command("inspect", "before-launch"));
  assert.equal(object(uncertain.outcome).kind, "unobserved"); assert.equal(object(uncertain.containment).kind, "unknown");
  assert.equal(object(object(await command("adopt", "before-launch")).phase).kind, "attempted");
  const recovery = object(await backend.call({ tasks: true })); assert.equal(recovery.providerCalls, 0); assert.ok(Array.isArray(recovery.tasks));
  assert.equal(object(recovery.inspection).scheduling, "paused");
  const recoveredAttempt = recovery.tasks.map(object).find(record => String(record.id) === beforeLaunchTask.taskKey);
  assert.ok(recoveredAttempt !== undefined); assert.equal(object(recoveredAttempt.state).status, "pending");
  assert.equal(object(await backend.call({ abort: true })).providerCalls, 0);
  const afterAbort = object(await backend.call({ tasks: true })); assert.equal(afterAbort.providerCalls, 0); assert.ok(Array.isArray(afterAbort.tasks));
  const joinedAttempt = afterAbort.tasks.map(object).find(record => String(record.id) === beforeLaunchTask.taskKey);
  assert.ok(joinedAttempt !== undefined); const joinedState = object(joinedAttempt.state); assert.equal(joinedState.status, "terminal");
  const joinedOutcome = object(joinedState.outcome);
  if (joinedOutcome.status === "completed") assert.deepEqual(joinedOutcome.result, { intentId: "before-launch", phase: "attempted" });
  else assert.equal(joinedOutcome.status, "aborted");
  assert.deepEqual(await command("inspect", "before-launch"), uncertain);
  assert.equal(object(object(object(await command("describe", "before-launch")).command).phase).kind, "attempted");
  const progress = object(await backend.call({ operation: { op: "execution.status", workspaceId: "coding" } }));
  assert.ok(Array.isArray(progress.unresolved)); assert.equal(progress.unresolved.length, 1);
  await assert.rejects(backend.call({ operation: { op: "command.reconcile", workspaceId: "coding", intentId: "before-launch", reference: "Missing launch evidence is not empty containment", containment: { kind: "manager" } } }));
  await backend.call({ operation: { op: "command.reconcile", workspaceId: "coding", intentId: "before-launch", reference: "Explicitly acknowledge the interrupted pre-launch attempt, without inventing a program outcome", containment: { kind: "trusted-offline", reference: "Source Node killed after durable attempt; missing activation is not release authority" } } });
  await assert.rejects(command("release", "before-launch"));
  assert.deepEqual(await command("inspect", "before-launch"), uncertain);
  assert.equal(object(object(object(await command("start", "before-launch")).command).phase).kind, "reconciled");
  await assert.rejects(readFile(neverLaunched), { code: "ENOENT" });
  const finalDb = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  try {
    const events = finalDb.prepare("SELECT record_json FROM herdr_execution_records ORDER BY sequence").all().map(row => object(object(JSON.parse(String(row.record_json))).event)).filter(event => event.intentId === "before-launch" || (event.kind === "command.authorized" && typeof event.specJson === "string" && parseCommandSpec(event.specJson).intentId === "before-launch"));
    assert.deepEqual(events.map(event => event.kind), ["command.authorized", "command.attempted", "command.reconciled"]);
  } finally { finalDb.close(); }
  assert.deepEqual(object(await backend.call({ operation: { op: "execution.status", workspaceId: "coding" } })).unresolved, []);
  backend.child.disconnect(); assert.equal((await backend.exit).code, 0); backend = undefined;
  const result = { path, helper, verdict: "composite-host-owned-command", originalInvocationId: original.activation.invocationId, realSdkTaskKey: task.taskKey, realSdkConversationKey: task.conversationKey, actualBackendSigkill: true, injectedLostPostLaunchAcknowledgment: true, receiptAdoptedWithoutReplay: true, oneDurableAttemptPerConsumedIntent: true, originalCustodyReleased: true, actualBackendSigkillBeforeAttempt: true, expiredGrantNeverRecaptured: true, recoveredUnattemptedTaskFaulted: true, unattemptedSdkTaskKey: pendingTask.taskKey, actualBackendSigkillAfterAttemptBeforeLaunch: true, beforeLaunchSdkTaskKey: beforeLaunchTask.taskKey, sdkAbortJoinedControlWithoutCancellingAttempt: true, offlineAcknowledgmentDidNotGrantRelease: true, modelCommandToolRegistered: false, providerGenerations: 0 };
  await writeFile(join(path, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(result));
} catch (error) { failures.push(error); }
try {
  await writeFile(finish, "finish", { mode: 0o600 });
  if (namespaceRequested) {
    if (backend === undefined || backend.child.exitCode !== null || backend.child.signalCode !== null) backend = await start("normal");
    await command("cancel"); await adopted(); await command("release"); namespaceRequested = false;
  }
  if (unattemptedAuthorized) {
    if (backend === undefined || backend.child.exitCode !== null || backend.child.signalCode !== null) backend = await start("normal");
    const phase = object(object(object(await command("describe", "unattempted")).command).phase).kind;
    if (phase === "authorized") await command("cancel", "unattempted");
    else if (phase === "activated" || phase === "adopted") { await adopted("unattempted"); await command("release", "unattempted"); }
    else throw new Error("Retain unknown unattempted-proof outcome");
    unattemptedAuthorized = false;
  }
} catch (error) { failures.push(error); }
if (backend !== undefined) {
  if (backend.child.connected) backend.child.disconnect();
  const deadline = setTimeout(() => backend?.child.kill("SIGKILL"), 5000);
  try { await backend.exit; } catch (error) { failures.push(error); } finally { clearTimeout(deadline); }
}
if (failures.length !== 0) throw new AggregateError(failures, `Composite host proof or cleanup failed; preserve ${path}`);
