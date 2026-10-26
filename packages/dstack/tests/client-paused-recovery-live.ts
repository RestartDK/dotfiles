import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { clientToken, newClientCredential } from "#client-authority";
import { clientMessages, clientRecord } from "../src/client-reader.js";
import { parseHostConfig } from "#host-protocol";

function executable(key: "DSTACK_TEST_NODE" | "DSTACK_TEST_PYTHON"): string {
  const path = process.env[key];
  if (path === undefined || !path.startsWith("/nix/store/")) throw new Error(`Explicit production executable required: ${key}`);
  return path;
}
const node = executable("DSTACK_TEST_NODE"), python = executable("DSTACK_TEST_PYTHON");
const root = await mkdtemp(join(tmpdir(), "client-paused-")), cwd = join(root, "workspace"), target = join(cwd, "held.txt"), configFile = join(root, "config.json");
process.stderr.write(`${JSON.stringify({ fixture: "client-paused", root })}\n`);
await mkdir(cwd, { mode: 0o700 }); await writeFile(target, "original\n", { flag: "wx", mode: 0o600, flush: true });
const identity = { deploymentId: "client-paused-proof", domain: "personal", nodeId: "fixture" } satisfies Parameters<typeof newClientCredential>[0]["identity"];
const credential = newClientCredential({ identity, principalId: "reader" }), tokenFile = join(root, "reader.key");
await writeFile(tokenFile, JSON.stringify(credential), { flag: "wx", mode: 0o600, flush: true });
await writeFile(configFile, JSON.stringify({ identity, stateRoot: join(root, "state"), model: { provider: "host-command-fixture", modelId: "idle" }, thinkingLevel: "off", authPath: join(root, "unused-auth"), modelsPath: join(root, "unused-models"), execution: { mode: "durable", maxRecords: 256, clients: { version: 1, listen: { host: "127.0.0.1", port: 0 }, workspaces: [{ workspaceId: "coding", cwd }], grants: [{ principalId: "reader", tokenFile, workspaces: [{ workspaceId: "coding", permissions: ["read"] }] }] } } }), { flag: "wx", mode: 0o600, flush: true });
async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), 15000); })]); }
  finally { clearTimeout(timer); }
}
const custodyProgram = `import json,os,signal,sys
fd=os.pidfd_open(int(sys.argv[1]),0)
try:
 boot=open('/proc/sys/kernel/random/boot_id').read().strip()
 stat=open('/proc/'+sys.argv[1]+'/stat').read()
 ticks=stat[stat.rfind(')')+2:].split()[19]
 signal.pidfd_send_signal(fd,0)
 print(json.dumps({'bootId':boot,'birthTicks':ticks}),flush=True)
 line=sys.stdin.readline(2049)
 if line:
  request=json.loads(line)
  assert set(request)=={'bootId','birthTicks','signal'} and request=={'bootId':boot,'birthTicks':ticks,'signal':'SIGKILL'}
  assert open('/proc/sys/kernel/random/boot_id').read().strip()==boot
  signal.pidfd_send_signal(fd,0)
  signal.pidfd_send_signal(fd,signal.SIGKILL)
  print(json.dumps({'signalled':'SIGKILL'}),flush=True)
 else:
  try:
   signal.pidfd_send_signal(fd,0)
  except ProcessLookupError:
   print(json.dumps({'originalExited':True}),flush=True)
  else:
   raise RuntimeError('Refusing to retire a live original pidfd')
finally:
 os.close(fd)
`;
async function start(input: { mode: "file-hold" | "normal"; configFile: string }) {
  const child = fork(fileURLToPath(new URL("./host-command-fixture.js", import.meta.url)), [input.configFile, input.mode, target], { execPath: node, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  assert.ok(child.pid !== undefined);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 32768) stderr += chunk.toString(); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  void exit.catch(() => undefined);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const events = new Map<string, Record<string, unknown>>(), waiting = new Map<string, (value: Record<string, unknown>) => void>();
  let next = 0;
  child.on("message", (value: unknown) => {
    const message = clientRecord(value);
    if (typeof message.event === "string") { events.set(message.event, message); waiting.get(message.event)?.(message); waiting.delete(message.event); }
    else if (typeof message.id === "number") {
      const request = pending.get(message.id); pending.delete(message.id);
      if ("error" in message) request?.reject(new Error("Trusted fixture refused", { cause: message.code })); else request?.resolve(message.value);
    }
  });
  const guardian = spawn(python, ["-u", "-c", custodyProgram, String(child.pid)], { stdio: ["pipe", "pipe", "pipe"] });
  guardian.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 32768) stderr += chunk.toString(); });
  const guardianExit = new Promise<number | null>((resolve, reject) => { guardian.once("error", reject); guardian.once("exit", resolve); });
  void guardianExit.catch(() => undefined); guardian.stdin.on("error", () => undefined);
  const lines = createInterface({ input: guardian.stdout })[Symbol.asyncIterator]();
  const event = (name: string) => bounded(events.has(name) ? Promise.resolve(events.get(name)) : new Promise<Record<string, unknown>>(resolve => waiting.set(name, resolve)), `Missing backend event ${name}: ${stderr}`);
  try {
    const ready = clientRecord(await event("ready")), owned = clientRecord(JSON.parse(String((await bounded(lines.next(), "Pidfd custody readiness")).value)));
    assert.deepEqual(owned, { bootId: ready.bootId, birthTicks: ready.birthTicks }, "Original opened pidfd must match self-reported source boot and birth ticks");
    assert.equal(typeof ready.endpoint, "string"); const endpoint = String(ready.endpoint);
    const call = async (value: object): Promise<Record<string, unknown>> => {
      const id = ++next;
      return clientRecord(await bounded(new Promise<unknown>((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, ...value }); }), `Backend request ${id}: ${stderr}`));
    };
    let closing: Promise<void> | undefined;
    const close = (kind: "kill" | "graceful"): Promise<void> => closing ??= (async () => {
      if (kind === "kill") {
        guardian.stdin.end(`${JSON.stringify({ bootId: ready.bootId, birthTicks: ready.birthTicks, signal: "SIGKILL" })}\n`);
        assert.deepEqual(clientRecord(JSON.parse(String((await bounded(lines.next(), "Original pidfd signal acknowledgment")).value))), { signalled: "SIGKILL" });
      } else if (child.connected) child.disconnect();
      const result = await bounded(exit, `Backend did not close: ${stderr}`);
      guardian.stdin.end();
      if (kind === "graceful") assert.deepEqual(clientRecord(JSON.parse(String((await bounded(lines.next(), "Original dead-source retirement")).value))), { originalExited: true });
      assert.equal(await bounded(guardianExit, "Pidfd custody did not close"), 0, stderr);
      await lines.return?.();
      if (kind === "kill") assert.equal(result.signal, "SIGKILL"); else assert.equal(result.code, 0, stderr);
    })();
    async function rpc(operation: object) {
      const id = randomUUID(), response = await fetch(`${endpoint}/v1`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${clientToken(credential)}` }, body: JSON.stringify({ v: 1, id, operation: { workspaceId: "coding", ...operation } }), signal: AbortSignal.timeout(10000) });
      const values = [];
      for await (const value of clientMessages(response, id)) values.push(value);
      assert.equal(values.length, 1); const value = values[0]; assert.ok(value !== undefined);
      return { status: response.status, value };
    }
    async function watch() {
      const id = randomUUID(), response = await fetch(`${endpoint}/v1`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${clientToken(credential)}` }, body: JSON.stringify({ v: 1, id, operation: { op: "watch", workspaceId: "coding" } }), signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200);
      for await (const value of clientMessages(response, id)) { assert.equal(value.kind, "event"); if (value.kind === "event") { assert.equal(value.value.type, "snapshot"); assert.equal("seq" in value.value, false); } return; }
      assert.fail("Actual paused SDK atomic snapshot missing");
    }
    return { call, close, event, rpc, watch };
  } catch (error) {
    const failures: unknown[] = [error];
    if (child.connected) child.disconnect();
    try {
      assert.equal((await bounded(exit, "Failed startup backend join")).code, 0, stderr);
      guardian.stdin.end();
      assert.deepEqual(clientRecord(JSON.parse(String((await bounded(lines.next(), "Failed startup original dead-source retirement")).value))), { originalExited: true });
      assert.equal(await bounded(guardianExit, "Failed startup guardian join"), 0, stderr);
    } catch (cleanup) { failures.push(cleanup); }
    try { await bounded(Promise.resolve(lines.return?.()), "Failed startup reader join"); } catch (cleanup) { failures.push(cleanup); }
    throw new AggregateError(failures, `Backend startup failed; preserve ${root}`);
  }
}
let backend: Awaited<ReturnType<typeof start>> | undefined, mode: "kill" | "graceful" = "kill";
const failures: unknown[] = [];
try {
  const startupConfig = join(root, "startup-config.json"), parsed = parseHostConfig(JSON.parse(await readFile(configFile, "utf8")));
  await writeFile(startupConfig, JSON.stringify({ ...parsed, stateRoot: join(root, "startup-state"), execution: { mode: "durable", maxRecords: 256 } }), { flag: "wx", mode: 0o600, flush: true });
  await assert.rejects(start({ mode: "normal", configFile: startupConfig }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 1, new Error("Startup must join both original children without cleanup failures", { cause: error }));
    assert.match(String(error.errors[0]), /Original opened pidfd/); return true;
  });
  backend = await start({ mode: "file-hold", configFile });
  await backend.call({ operation: { op: "create", workspaceId: "coding", requestId: "create", cwd } });
  await backend.call({ operation: { op: "submit", workspaceId: "coding", requestId: "write", content: "Exercise actual paused native file recovery" } });
  await backend.event("file-held");
  const before = await backend.call({ operation: { op: "execution.status", workspaceId: "coding" } });
  assert.equal(before.sequence, 1); assert.ok(Array.isArray(before.unresolved) && before.unresolved.length === 1);
  const first = await backend.call({ tasks: true }); assert.equal(first.providerCalls, 1); assert.ok(Array.isArray(first.tasks));
  const actual = first.tasks.map(clientRecord).find(task => task.kind === "pi.tool" && clientRecord(task.state).status !== "terminal"); assert.ok(actual !== undefined);
  const taskKey = String(actual.id);
  await backend.close("kill"); backend = undefined;
  await writeFile(target, "trusted after physical death\n", { mode: 0o600, flush: true });
  backend = await start({ mode: "normal", configFile }); mode = "graceful";
  const reopened = await backend.call({ tasks: true }); assert.equal(reopened.providerCalls, 0); assert.ok(Array.isArray(reopened.tasks));
  const recovered = reopened.tasks.map(clientRecord).find(task => String(task.id) === taskKey); assert.ok(recovered !== undefined); assert.notEqual(clientRecord(recovered.state).status, "terminal", "Reopened actual task must still be paused before any viewer");
  await writeFile(join(root, "before-read.json"), JSON.stringify(reopened, null, 2), { flag: "wx", mode: 0o600 });
  for (const operation of [{ op: "snapshot" }, { op: "execution.status" }, { op: "status", requestId: "guessed-writer-key" }]) { const value = await backend.rpc(operation); assert.equal(value.status, 200); assert.equal(value.value.kind, "reply"); }
  await backend.watch(); await backend.watch();
  for (const operation of [{ op: "open" }, { op: "submit", requestId: "forbidden", content: "must not infer" }, { op: "abort" }, { op: "command.cancel", intentId: "guessed" }]) { const value = await backend.rpc(operation); assert.equal(value.status, 403); assert.equal(value.value.kind, "error"); }
  const after = await backend.call({ tasks: true }); assert.equal(after.providerCalls, 0); assert.deepEqual(after.tasks, reopened.tasks, "Read-only attach and denied mutations must not schedule or change recovered tasks");
  const execution = await backend.call({ operation: { op: "execution.status", workspaceId: "coding" } }); assert.deepEqual(execution, before);
  assert.equal(await readFile(target, "utf8"), "trusted after physical death\n");
  const cleanup = await backend.call({ abort: true }); assert.equal(cleanup.providerCalls, 0, "Only explicit trusted fixture cleanup aborts ordinary SDK work");
  assert.deepEqual(await backend.call({ operation: { op: "execution.status", workspaceId: "coding" } }), before, "SDK cleanup cannot settle the independent file effect");
  await backend.close("graceful"); backend = undefined;
  const result = { proof: "authenticated-read-only-physical-paused-recovery", root, physicalOriginalPidfdSigkill: true, startupFailureOriginalChildrenJoined: true, actualRecoveredToolTask: taskKey, twoFreshAtomicSnapshots: true, readOnlyDidNotScheduleOrInfer: true, deniedMutationsDidNotReachSdk: true, trustedEditPreserved: true, unresolvedJournalPreserved: true, trustedSdkAbortOnlyAfterReadAssertions: true, productionModel: false };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 }); process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { failures.push(error); }
if (backend !== undefined) { try { await backend.close(mode); } catch (error) { failures.push(error); } }
if (failures.length > 0) throw new AggregateError(failures, `Read-only physical recovery failed; preserve ${root}`);
