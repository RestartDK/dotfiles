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
async function start(mode: "hold-launch" | "normal"): Promise<Backend> {
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
let namespaceRequested = false;
const failures: unknown[] = [];
async function command(op: string) {
  assert.ok(backend !== undefined); return backend.call({ command: { op, workspaceId: "coding", intentId: "once" } });
}
async function adopted(): Promise<Record<string, unknown>> {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    const state = object(await command("adopt"));
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
  const result = { path, helper, verdict: "composite-host-owned-command", originalInvocationId: original.activation.invocationId, realSdkTaskKey: task.taskKey, realSdkConversationKey: task.conversationKey, actualBackendSigkill: true, injectedLostPostLaunchAcknowledgment: true, receiptAdoptedWithoutReplay: true, oneDurableAttempt: true, originalCustodyReleased: true, modelCommandToolRegistered: false, providerGenerations: 0 };
  await writeFile(join(path, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(result));
} catch (error) { failures.push(error); }
try {
  await writeFile(finish, "finish", { mode: 0o600 });
  if (namespaceRequested) {
    if (backend === undefined || backend.child.exitCode !== null || backend.child.signalCode !== null) backend = await start("normal");
    await command("cancel"); await adopted(); await command("release"); namespaceRequested = false;
  }
} catch (error) { failures.push(error); }
if (backend !== undefined) {
  if (backend.child.connected) backend.child.disconnect();
  const deadline = setTimeout(() => backend?.child.kill("SIGKILL"), 5000);
  try { await backend.exit; } catch (error) { failures.push(error); } finally { clearTimeout(deadline); }
}
if (failures.length !== 0) throw new AggregateError(failures, `Composite host proof or cleanup failed; preserve ${path}`);
