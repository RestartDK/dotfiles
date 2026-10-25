import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const node = process.env.DSTACK_TEST_NODE;
assert.ok(node !== undefined && node.startsWith("/nix/store/"), "Explicit production Node required");
const audit = join(await realpath(process.cwd()), ".audit"); await mkdir(audit, { recursive: true, mode: 0o700 });
const path = await mkdtemp(join(audit, "host-file-crash-")), cwd = join(path, "workspace"), stateRoot = join(path, "state");
await mkdir(cwd, { mode: 0o700 });
const target = join(cwd, "held.txt"), config = join(path, "config.json");
await writeFile(target, "original\n", { flag: "wx", mode: 0o600 });
await writeFile(config, JSON.stringify({ identity: { deploymentId: "file-crash-proof", domain: "personal", nodeId: "fixture" }, stateRoot, model: { provider: "host-command-fixture", modelId: "idle" }, thinkingLevel: "off", authPath: join(path, "auth.json"), modelsPath: join(path, "models.json"), execution: { mode: "durable", maxRecords: 128 } }), { flag: "wx", mode: 0o600 });
function object(value: unknown): Record<string, unknown> { assert.ok(typeof value === "object" && value !== null && !Array.isArray(value)); return Object.fromEntries(Object.entries(value)); }
type Backend = {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  call(request: object): Promise<unknown>;
  event(name: string): Promise<Record<string, unknown>>;
};
async function start(mode: "file-hold" | "normal"): Promise<Backend> {
  const child = fork(fileURLToPath(new URL("./host-command-fixture.js", import.meta.url)), [config, mode, target], { execPath: node, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; deadline: NodeJS.Timeout }>();
  const observed = new Map<string, Record<string, unknown>>();
  const waiting = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; deadline: NodeJS.Timeout }>();
  let next = 0, stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 32768) stderr += chunk.toString(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const failure = new Error(`File backend exited ${code}/${signal}: ${stderr}`);
      for (const entry of pending.values()) { clearTimeout(entry.deadline); entry.reject(failure); }
      for (const entry of waiting.values()) { clearTimeout(entry.deadline); entry.reject(failure); }
      pending.clear(); waiting.clear(); resolve({ code, signal });
    });
  });
  child.on("message", (value: unknown) => {
    const message = object(value);
    if (typeof message.event === "string") {
      observed.set(message.event, message);
      const entry = waiting.get(message.event);
      if (entry !== undefined) { clearTimeout(entry.deadline); waiting.delete(message.event); entry.resolve(message); }
    } else if (typeof message.id === "number") {
      const entry = pending.get(message.id);
      if (entry !== undefined) {
        clearTimeout(entry.deadline); pending.delete(message.id);
        if ("error" in message) entry.reject(new Error("Trusted file fixture refused request", { cause: message.code })); else entry.resolve(message.value);
      }
    }
  });
  const backend: Backend = {
    child, exit,
    call(request) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { pending.delete(id); reject(new Error("File request deadline")); }, 15000);
        pending.set(id, { resolve, reject, deadline }); child.send({ id, ...request });
      });
    },
    event(name) {
      const value = observed.get(name); if (value !== undefined) return Promise.resolve(value);
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { waiting.delete(name); reject(new Error(`File event deadline: ${name}`)); }, 15000);
        waiting.set(name, { resolve, reject, deadline });
      });
    },
  };
  try { await backend.event("ready"); return backend; }
  catch (error) { child.kill("SIGKILL"); await exit; throw error; }
}
let backend: Backend | undefined;
const failures: unknown[] = [];
const operation = (value: object) => { assert.ok(backend !== undefined); return backend.call({ operation: { workspaceId: "coding", ...value } }); };
try {
  backend = await start("file-hold");
  await operation({ op: "create", requestId: "create", cwd });
  await operation({ op: "submit", requestId: "write", content: "exercise native file crash recovery" });
  const held = await backend.event("file-held"); assert.equal(held.path, target);
  const before = object(await operation({ op: "execution.status" }));
  assert.ok(Array.isArray(before.unresolved) && before.unresolved.length === 1);
  const effect = object(before.unresolved[0]); assert.equal(effect.kind, "file"); assert.ok(typeof effect.effectId === "string");
  assert.equal(before.sequence, 1);
  const inspection = object(await backend.call({ tasks: true })); assert.equal(inspection.providerCalls, 1);
  assert.ok(Array.isArray(inspection.tasks));
  const database = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  let sdk: Record<string, unknown>;
  try {
    const row = database.prepare("SELECT record_json FROM herdr_execution_records").get();
    const event = object(object(JSON.parse(String(row?.record_json))).event); assert.equal(event.kind, "file.started"); sdk = object(event.sdk);
  } finally { database.close(); }
  const actual = inspection.tasks.map(object).find(task => String(task.id) === sdk.taskKey);
  assert.ok(actual !== undefined); assert.equal(actual.kind, "pi.tool");
  assert.deepEqual(sdk, { taskKey: String(actual.id), conversationKey: String(actual.conversationId), callId: object(actual.input).callId });
  assert.equal(await readFile(target, "utf8"), "original\n");
  backend.child.kill("SIGKILL"); assert.equal((await backend.exit).signal, "SIGKILL"); backend = undefined;
  await writeFile(target, "trusted after crash\n", { mode: 0o600 });
  backend = await start("normal");
  const reopened = object(await operation({ op: "execution.status" })); assert.deepEqual(reopened.unresolved, [effect]); assert.equal(reopened.sequence, 1);
  await assert.rejects(operation({ op: "submit", requestId: "blocked", content: "must not infer" }), error => error instanceof Error && error.cause === "effect_unresolved");
  const cleanup = object(await backend.call({ abort: true })); assert.equal(cleanup.providerCalls, 0, "Abort cleanup must remain available without inference");
  const afterAbort = object(await operation({ op: "execution.status" })); assert.deepEqual(afterAbort.unresolved, [effect]); assert.equal(afterAbort.sequence, 1);
  const after = object(await backend.call({ tasks: true })); assert.equal(after.providerCalls, 0);
  assert.ok(Array.isArray(after.tasks));
  const recovered = after.tasks.map(object).find(task => String(task.id) === sdk.taskKey); assert.ok(recovered !== undefined);
  assert.equal(object(recovered.state).status, "terminal");
  assert.equal(await readFile(target, "utf8"), "trusted after crash\n", "Recovered native mutation must not replay");
  await operation({ op: "file.reconcile", effectId: effect.effectId, reference: "operator inspected trusted edit after physical backend death and explicit SDK abort" });
  const reconciled = object(await operation({ op: "execution.status" })); assert.deepEqual(reconciled.unresolved, []); assert.equal(reconciled.sequence, 2);
  assert.equal(await readFile(target, "utf8"), "trusted after crash\n", "Reconciliation must not replay the interrupted write");
  const verify = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  try {
    const events = verify.prepare("SELECT record_json FROM herdr_execution_records ORDER BY sequence").all().map(row => object(object(JSON.parse(String(row.record_json))).event));
    assert.deepEqual(events.map(event => event.kind), ["file.started", "file.reconciled"]);
  } finally { verify.close(); }
  const result = { proof: "physical-backend-native-file-crash", path, actualBackendSigkillAfterFileStarted: true, actualSdkProvenance: sdk, trustedEditPreservedWithoutReplay: true, abortWhileUnresolvedDidNotInfer: true, explicitReconciliationDidNotFabricateAdoption: true };
  await writeFile(join(path, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(result));
} catch (error) { failures.push(error); }
if (backend !== undefined) {
  if (backend.child.connected) backend.child.disconnect();
  const deadline = setTimeout(() => backend?.child.kill("SIGKILL"), 5000);
  try { assert.equal((await backend.exit).code, 0); } catch (error) { failures.push(error); } finally { clearTimeout(deadline); }
}
if (failures.length) throw new AggregateError(failures, `Native file crash proof failed; preserve ${path}`);
