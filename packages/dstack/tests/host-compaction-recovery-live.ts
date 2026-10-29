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
const path = await mkdtemp(join(audit, "host-summary-recovery-"));
const cwd = join(path, "workspace"); await mkdir(cwd, { mode: 0o700 });
const stateRoot = join(path, "state"), marker = join(cwd, "ready.txt"), configPath = join(path, "config.json");
await writeFile(configPath, JSON.stringify({ identity: { deploymentId: "summary-recovery-proof", domain: "personal", nodeId: "fixture" }, stateRoot, model: { provider: "host-command-fixture", modelId: "idle" }, thinkingLevel: "off", authPath: join(path, "auth.json"), modelsPath: join(path, "models.json"), execution: { mode: "durable", maxRecords: 256 } }), { flag: "wx", mode: 0o600 });
function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value)); return Object.fromEntries(Object.entries(value));
}
type Backend = {
  readonly child: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  call(request: object): Promise<unknown>;
  event(name: string): Promise<Record<string, unknown>>;
};
async function start(mode: "hold-summary" | "normal"): Promise<Backend> {
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

const manager = process.env.DSTACK_SYSTEMCTL; assert.ok(typeof manager === "string" && manager.startsWith("/nix/store/"));
let backend: Backend | undefined;
let custody: "none" | "owned" | "released" = "none";
const failures: unknown[] = [];
function current(): Backend { assert.ok(backend !== undefined); return backend; }
const command = (op: string) => current().call({ command: { op, workspaceId: "coding", intentId: "during-summary" } });
const operation = (value: object) => current().call({ operation: { workspaceId: "coding", ...value } });
async function until<T>(action: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 12000;
  while (performance.now() < deadline) { const value = await action(); if (value !== undefined) return value; await delay(20); }
  throw new Error("Recovered summary observation deadline");
}
function actual(view: Record<string, unknown>, key: string): Record<string, unknown> {
  assert.ok(Array.isArray(view.tasks)); const task = view.tasks.map(object).find(task => String(task.id) === key); assert.ok(task !== undefined); return task;
}
try {
  backend = await start("hold-summary");
  await operation({ op: "create", requestId: "create", cwd });
  for (const requestId of ["first", "second"]) {
    await operation({ op: "submit", requestId, content: requestId });
    await until(async () => { const view = object(await operation({ op: "status", requestId })); return view.receipt !== null && object(view.receipt).status === "done" ? true : undefined; });
  }
  assert.equal(object(await current().call({ tasks: true })).providerCalls, 2);
  const authorized = object(await current().call({ command: { op: "authorize", workspaceId: "coding", authorization: { intentId: "during-summary", argv: [node, "-e", "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],'ready',{flag:'wx'});setInterval(()=>{},1000)", marker], timeoutSeconds: 15 } } }));
  const specJson = object(authorized.authorization).specJson; assert.ok(typeof specJson === "string"); const spec = parseCommandSpec(specJson);
  const compact = object(await current().call({ compact: true })); assert.ok(typeof compact.taskKey === "string");
  await current().event("summary-held");
  const held = object(await current().call({ tasks: true })), task = actual(held, compact.taskKey), heldState = object(task.state);
  assert.equal(task.kind, "pi.compaction"); assert.equal(heldState.status, "running"); assert.equal(object(heldState.checkpoint).phase, "summarize"); assert.equal(held.providerCalls, 2);
  custody = "owned";
  const sdk = object(await command("start")); assert.ok(typeof sdk.taskKey === "string" && typeof sdk.conversationKey === "string");
  await until(async () => { try { return await readFile(marker, "utf8"); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined; throw error; } });
  const active = object(await command("inspect")); assert.equal(object(active.outcome).kind, "unobserved"); assert.equal(object(active.containment).kind, "active");
  const evidence = parseCommandEvidence(JSON.stringify(object(active.containment).evidence)); assert.equal(evidence.executionId, spec.executionId);
  await writeFile(join(path, "before-crash.json"), JSON.stringify({ compact, sdk, task, active }, null, 2), { flag: "wx", mode: 0o600 });
  backend.child.kill("SIGKILL"); assert.equal((await backend.exit).signal, "SIGKILL"); backend = undefined;
  backend = await start("normal");
  const recovered = object(await current().call({ tasks: true }));
  assert.equal(object(recovered.inspection).scheduling, "paused"); assert.equal(recovered.providerCalls, 0);
  const recoveredTask = actual(recovered, compact.taskKey); assert.equal(recoveredTask.kind, "pi.compaction"); assert.equal(object(object(recoveredTask.state).checkpoint).phase, "summarize");
  assert.equal(object(await current().call({ idle: true })).providerCalls, 0);
  const after = object(await current().call({ tasks: true })), failed = actual(after, compact.taskKey), failedState = object(failed.state);
  assert.equal(after.providerCalls, 0); assert.equal(failedState.status, "terminal"); assert.equal(object(failedState.outcome).status, "faulted");
  assert.match(JSON.stringify(failed), /Unresolved execution effects block workspace progress/);
  const stillActive = object(await command("inspect")); assert.equal(object(stillActive.containment).kind, "active"); assert.equal(object(stillActive.outcome).kind, "unobserved");
  await command("cancel");
  const done = await until(async () => { const value = object(await command("inspect")); return object(value.outcome).kind === "recorded" && object(value.containment).kind === "empty" ? value : undefined; });
  const outcome = object(object(object(done.outcome).receipt).outcome); assert.equal(outcome.kind, "signal"); assert.equal(outcome.cause, "cancelled");
  assert.equal(object(object(await command("adopt")).phase).kind, "adopted"); await command("release"); custody = "released";
  const cleaned = spawnSync(manager, ["--user", "show", spec.unit, "--property=NFileDescriptorStore", "--value"], { encoding: "utf8", timeout: 5000 });
  assert.equal(cleaned.status, 0, cleaned.stderr); assert.equal(cleaned.stdout.trim(), "0");
  const db = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  try {
    const events = db.prepare("SELECT record_json FROM herdr_execution_records ORDER BY sequence").all().map(row => object(object(JSON.parse(String(row.record_json))).event));
    assert.deepEqual(events.map(event => event.kind), ["command.authorized", "command.attempted", "command.activated", "command.cancel-requested", "command.adopted"]);
    assert.deepEqual(events[1]?.sdk, { kind: "task", taskKey: sdk.taskKey, conversationKey: sdk.conversationKey });
  } finally { db.close(); }
  const result = { proof: "actual-recovered-compaction-summarize", path, compact, sdk, originalInvocationId: evidence.activation.invocationId, checkpointBeforeKill: "summarize", actualBackendSigkill: true, recoveredSummarizeFaultedBeforeProvider: true, providerCallsAfterRecovery: after.providerCalls, noImplicitBusinessCancellation: true, originalCancelledReceiptAndEmptyContainment: true, originalCustodyReleased: true, oneAttempt: true };
  await writeFile(join(path, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(result));
} catch (error) { failures.push(error); }
if (custody === "owned") {
  try {
    if (backend !== undefined) { backend.child.kill("SIGKILL"); await backend.exit; backend = undefined; }
    backend = await start("normal"); await current().call({ abort: true });
    const phase = object(object(object(await command("describe")).command).phase).kind;
    if (phase === "authorized") { await command("cancel"); custody = "none"; }
    else if (phase === "activated" || phase === "adopted") {
      await command("cancel"); await until(async () => object(object(await command("adopt")).phase).kind === "adopted" ? true : undefined); await command("release"); custody = "released";
    } else throw new Error("Retain unknown recovered-summary command outcome");
  } catch (error) { failures.push(error); }
}
if (backend !== undefined) {
  if (backend.child.connected) backend.child.disconnect();
  const closing = backend, deadline = setTimeout(() => closing.child.kill("SIGKILL"), 5000);
  try { assert.equal((await closing.exit).code, 0); } catch (error) { failures.push(error); } finally { clearTimeout(deadline); }
}
if (failures.length !== 0) throw new AggregateError(failures, `Recovered summary proof failed; preserve ${path}`);
