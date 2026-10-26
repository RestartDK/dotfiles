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
const path = await mkdtemp(join(audit, "host-helper-loss-"));
const cwd = join(path, "workspace"); await mkdir(cwd, { mode: 0o700 });
const stateRoot = join(path, "state"), configPath = join(path, "config.json");
await writeFile(configPath, JSON.stringify({ identity: { deploymentId: "host-helper-loss-proof", domain: "personal", nodeId: "fixture" }, stateRoot, model: { provider: "host-command-fixture", modelId: "idle" }, thinkingLevel: "off", authPath: join(path, "auth.json"), modelsPath: join(path, "models.json"), execution: { mode: "durable", maxRecords: 256 } }), { flag: "wx", mode: 0o600 });
function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value)); return Object.fromEntries(Object.entries(value));
}
type Backend = {
  readonly child: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  call(request: object): Promise<unknown>;
  event(name: string): Promise<Record<string, unknown>>;
};
async function start(mode: "normal"): Promise<Backend> {
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

const python = process.env.DSTACK_TEST_PYTHON, manager = process.env.DSTACK_SYSTEMCTL;
assert.ok(typeof python === "string" && python.startsWith("/nix/store/"));
assert.ok(typeof manager === "string" && manager.startsWith("/nix/store/"));
assert.equal(process.getuid?.(), 1000);
const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
type ChildIdentity = { readonly pid: number; readonly startTicks: string };
function identity(value: unknown): ChildIdentity {
  const item = object(value);
  assert.ok(typeof item.pid === "number" && Number.isSafeInteger(item.pid) && item.pid > 0);
  assert.ok(typeof item.startTicks === "string" && /^[0-9]+$/.test(item.startTicks));
  return { pid: item.pid, startTicks: item.startTicks };
}
async function marker(name: string): Promise<ChildIdentity | undefined> {
  try { return identity(JSON.parse(await readFile(join(cwd, name), "utf8"))); }
  catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
async function until<T>(action: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) { const value = await action(); if (value !== undefined) return value; await delay(20); }
  throw new Error("Helper loss observation deadline");
}
const backend = await start("normal");
const command = (op: string) => backend.call({ command: { op, workspaceId: "coding", intentId: "fault" } });
const save = (name: string, value: unknown) => writeFile(join(path, name), JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
let custody: "none" | "owned" | "released" = "none";
const failures: unknown[] = [];
try {
  await backend.call({ operation: { op: "create", requestId: "create", workspaceId: "coding", cwd } });
  const birth = "const fs=require('node:fs');process.on('SIGTERM',()=>{});const s=fs.readFileSync('/proc/self/stat','utf8');const startTicks=s.slice(s.lastIndexOf(')')+2).split(' ')[19];fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,startTicks}),{flag:'wx',mode:384});";
  const descendant = birth + "setInterval(()=>{},1000);";
  const payload = birth + "require('node:child_process').spawn(process.execPath,['-e'," + JSON.stringify(descendant) + ",process.argv[2]],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);";
  const authorized = object(await backend.call({ command: { op: "authorize", workspaceId: "coding", authorization: { intentId: "fault", argv: [node, "-e", payload, join(cwd, "payload.json"), join(cwd, "descendant.json")], timeoutSeconds: 30 } } }));
  const specJson = object(authorized.authorization).specJson; assert.ok(typeof specJson === "string");
  const spec = parseCommandSpec(specJson);
  custody = "owned";
  const sdk = object(await command("start")); assert.ok(typeof sdk.taskKey === "string" && typeof sdk.conversationKey === "string");
  const payloadIdentity = await until(() => marker("payload.json")), descendantIdentity = await until(() => marker("descendant.json"));
  const active = object(await command("inspect")); assert.equal(object(active.outcome).kind, "unobserved"); assert.equal(object(active.containment).kind, "active");
  const evidence = parseCommandEvidence(JSON.stringify(object(active.containment).evidence));
  assert.equal(evidence.executionId, spec.executionId); assert.equal(evidence.activation.bootId, bootId);
  const faultInput = { bootId, helper: { pid: evidence.activation.pid, startTicks: evidence.activation.startTicks }, payload: payloadIdentity, descendant: descendantIdentity };
  await save("before-fault.json", { sdk, evidence, faultInput });
const code=`import json,os,signal,select,sys,time
x=json.load(sys.stdin)
assert open('/proc/sys/kernel/random/boot_id').read().strip()==x['bootId']
fds={}
try:
 for key in ['helper','payload','descendant']:
  p=x[key];f=os.pidfd_open(p['pid'],0);fds[key]=f
  s=open('/proc/%d/stat'%p['pid']).read();birth=s[s.rfind(')')+2:].split()[19]
  assert birth==p['startTicks'],(key,'birth mismatch')
  signal.pidfd_send_signal(f,0,None,0)
 signal.pidfd_send_signal(fds['helper'],signal.SIGKILL,None,0)
 poll=select.poll()
 for f in fds.values():poll.register(f,select.POLLIN)
 exited=set();end=time.monotonic()+12
 while len(exited)<len(fds) and time.monotonic()<end:
  for f,events in poll.poll(100):
   if events&select.POLLIN:exited.add(f);poll.unregister(f)
 assert len(exited)==len(fds),('original descendants not drained',len(exited))
 print(json.dumps({'originalHelperKilledViaPidfd':True,'originalPayloadAndDetachedTermIgnoringDescendantExited':True}))
finally:
 for f in fds.values():os.close(f)
`;

  const fault = spawnSync(python, ["-c", code], { input: JSON.stringify(faultInput), encoding: "utf8", timeout: 16000 });
  await save("fault-dispatch.json", { status: fault.status, signal: fault.signal, stdout: fault.stdout, stderr: fault.stderr, error: fault.error?.message });
  assert.equal(fault.status, 0, fault.stderr);
  const empty = await until(async () => { const value = object(await command("inspect")); return object(value.containment).kind === "empty" ? value : undefined; });
  assert.equal(object(empty.outcome).kind, "unobserved");
  assert.equal(object(object(await command("adopt")).phase).kind, "activated");
  await assert.rejects(command("release"));
  await backend.call({ operation: { op: "command.reconcile", workspaceId: "coding", intentId: "fault", reference: "Explicitly acknowledge intentional original-helper SIGKILL and unknown business outcome; independently held original pidfds observed descendant exit", containment: { kind: "manager" } } });
  const acknowledged = object(object(await command("describe")).command);
  const phase = object(acknowledged.phase); assert.equal(phase.kind, "reconciled"); assert.equal(object(object(phase.reconciliation).containment).kind, "manager");
  await command("release"); custody = "released";
  const cleaned = spawnSync(manager, ["--user", "show", evidence.activation.unit, "--property=NFileDescriptorStore", "--value"], { encoding: "utf8", timeout: 5000 });
  assert.equal(cleaned.status, 0, cleaned.stderr); assert.equal(cleaned.stdout.trim(), "0");
  assert.equal(object(object(await command("inspect")).outcome).kind, "unobserved");
  assert.equal(object(object(object(await command("start")).command).phase).kind, "reconciled");
  const db = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  try {
    const events = db.prepare("SELECT record_json FROM herdr_execution_records ORDER BY sequence").all().map(row => object(object(JSON.parse(String(row.record_json))).event));
    assert.deepEqual(events.map(event => event.kind), ["command.authorized", "command.attempted", "command.activated", "command.reconciled"]);
    assert.deepEqual(events[1]?.sdk, { kind: "task", taskKey: sdk.taskKey, conversationKey: sdk.conversationKey });
  } finally { db.close(); }
  assert.equal(object(await backend.call({ tasks: true })).providerCalls, 0);
  const result = { proof: "actual-host-helper-loss", path, sdk, originalInvocationId: evidence.activation.invocationId, originalHelperKilledViaPidfd: true, detachedTermIgnoringDescendantsDrained: true, businessOutcomeStillUnobserved: true, originalEmptyContainmentIndependentlyProven: true, explicitManagerAcknowledgmentDidNotInventExit: true, originalCustodyReleased: true, noReplay: true, providerGenerations: 0 };
  await save("result.json", result); console.log(JSON.stringify(result));
} catch (error) { failures.push(error); }
if (custody === "owned") failures.push(new Error("Retain unresolved original helper custody; no automatic reconciliation or name-based cleanup"));
if (backend.child.connected) backend.child.disconnect();
const deadline = setTimeout(() => backend.child.kill("SIGKILL"), 5000);
try { assert.equal((await backend.exit).code, 0); } catch (error) { failures.push(error); } finally { clearTimeout(deadline); }
if (failures.length !== 0) throw new AggregateError(failures, `Helper loss proof failed; preserve ${path}`);
