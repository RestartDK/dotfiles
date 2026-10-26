import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request, ServerResponse, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Harness, type Conversation } from "@earendil-works/pi-durable";
import { clientToken, newClientCredential } from "#client-authority";
import { ClientServer } from "#client-http";
import { CLIENT_RESOURCES } from "#client-wire";
import { DurableHost } from "#durable-host";
import { parseHostConfig } from "#host-protocol";
import { clientMessages, type ClientMessage } from "../src/client-reader.js";

process.umask(0o077);
const root = await mkdtemp(join(tmpdir(), "client-resources-")), cwd = join(root, "workspace"), eventCwd = join(root, "event-workspace"); await mkdir(cwd, { mode: 0o700 }); await mkdir(eventCwd, { mode: 0o700 });
process.stderr.write(`${JSON.stringify({ fixture: "client-resources", root })}\n`);
const identity = { deploymentId: "client-resources", domain: "personal", nodeId: "fixture" } satisfies Parameters<typeof newClientCredential>[0]["identity"];
const credential = newClientCredential({ identity, principalId: "writer" }), tokenFile = join(root, "writer.key");
await writeFile(tokenFile, JSON.stringify(credential), { flag: "wx", mode: 0o600, flush: true });
const config = parseHostConfig({ identity, stateRoot: join(root, "state"), model: { provider: "client-resources", modelId: "text" }, thinkingLevel: "off", authPath: join(root, "unused-auth"), modelsPath: join(root, "unused-models"), execution: { mode: "durable", maxRecords: 256, clients: { version: 1, listen: { host: "127.0.0.1", port: 0 }, workspaces: [{ workspaceId: "coding", cwd }, { workspaceId: "event", cwd: eventCwd }], grants: [{ principalId: "writer", tokenFile, workspaces: ["coding", "event"].map(workspaceId => ({ workspaceId, permissions: ["read", "submit"] })) }] } } });
const faux = fauxProvider({ api: "client-resources", provider: "client-resources", models: [{ id: "text", input: ["text"] }] }), models = createModels(); models.setProvider(faux.provider);
const originalOpen = Harness.open, nativeTimer = globalThis.setTimeout, nativeWrite = ServerResponse.prototype.write;
const timerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout"), writeDescriptor = Object.getOwnPropertyDescriptor(ServerResponse.prototype, "write"); assert.ok(timerDescriptor);
let conversation: Conversation | undefined, opens = 0, host: DurableHost | undefined, slowResponse: IncomingMessage | undefined;
const slowRequestClosed = Promise.withResolvers<void>(); let captureSlow = false, slowStarted = 0;
Harness.open = async (...args) => { opens += 1; const harness = await originalOpen(...args), rootConversation = harness.root.bind(harness); harness.root = async (...parameters) => { conversation = await rootConversation(...parameters); return conversation; }; return harness; };
function owned(): Conversation { assert.ok(conversation); return conversation; }
function bounded<T>(promise: Promise<T>, label: string, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = nativeTimer(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}
let endpoint = "";
const authorization = `Bearer ${clientToken(credential)}`;
function post(id: string, op: string, workspaceId = "coding"): Promise<Response> { return fetch(`${endpoint}/v1`, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ v: 1, id, operation: { op, workspaceId, ...(op === "status" ? { requestId: "absent" } : {}) } }) }); }
const cliCustody = `import json,os,signal,subprocess,sys
child=subprocess.Popen(sys.argv[1:],stdin=subprocess.DEVNULL,close_fds=True)
fd=os.pidfd_open(child.pid,0)
control=os.fdopen(3,'w',buffering=1)
try:
 boot=open('/proc/sys/kernel/random/boot_id').read().strip()
 stat=open('/proc/'+str(child.pid)+'/stat').read()
 ticks=stat[stat.rfind(')')+2:].split()[19]
 signal.pidfd_send_signal(fd,0)
 control.write(json.dumps({'originalPidfd':True,'bootId':boot,'birthTicks':ticks})+'\\n')
 command=sys.stdin.readline(32).strip()
 assert command in {'SIGINT','SIGTERM','wait'}
 assert open('/proc/sys/kernel/random/boot_id').read().strip()==boot
 if command!='wait':
  signal.pidfd_send_signal(fd,0)
  signal.pidfd_send_signal(fd,{'SIGINT':signal.SIGINT,'SIGTERM':signal.SIGTERM}[command])
 try:
  code=child.wait(timeout=12)
 except subprocess.TimeoutExpired:
  signal.pidfd_send_signal(fd,signal.SIGKILL)
  child.wait()
  raise
finally:
 if child.poll() is None:
  try:
   signal.pidfd_send_signal(fd,0)
   signal.pidfd_send_signal(fd,signal.SIGKILL)
  except ProcessLookupError:
   pass
  child.wait()
 os.close(fd)
control.write(json.dumps({'code':code,'originalPidfdClosed':True})+'\\n')
control.close()
`;
async function closedStderr(): Promise<void> {
  const monitorFile = join(root, "stderr-monitor.cjs");
  await writeFile(monitorFile, 'process.on("uncaughtExceptionMonitor", error => require("node:fs").writeSync(3, JSON.stringify({code:error.code})+"\\n"));', { flag: "wx", mode: 0o600 });
  const child = spawn(process.execPath, ["--require", monitorFile, fileURLToPath(new URL("../client-cli.js", import.meta.url)), "invalid-command"], { stdio: ["ignore", "ignore", "pipe", "pipe"] });
  const monitor = child.stdio[3]; assert.ok(monitor instanceof Readable); assert.ok(child.stderr !== null);
  let observed = ""; monitor.on("data", (chunk: Buffer) => { if (observed.length < 32768) observed += chunk.toString(); });
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  child.stderr.destroy();
  assert.equal(await bounded(closed, "CLI broken stderr retirement"), 1);
  assert.equal(observed, "", "Broken stderr must not become an uncaught Node error");
}
async function cliViewer(action: "SIGINT" | "SIGTERM" | "wait" | "broken-output"): Promise<number> {
  const python = process.env.DSTACK_TEST_PYTHON; assert.ok(python !== undefined && python.startsWith("/nix/store/"));
  const child = spawn(python, ["-u", "-c", cliCustody, process.execPath, fileURLToPath(new URL("../client-cli.js", import.meta.url)), "watch", "--endpoint", endpoint, "--credential", tokenFile, "--workspace", "coding"], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const control = child.stdio[3]; assert.ok(control instanceof Readable); assert.ok(child.stdin !== null && child.stdout !== null && child.stderr !== null);
  const lines = createInterface({ input: control })[Symbol.asyncIterator](), stdout = action === "wait" ? undefined : createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let stderr = "", stderrBytes = 0; child.stderr.setEncoding("utf8"); child.stderr.on("data", (text: string) => { stderrBytes += Buffer.byteLength(text); stderr = (stderr + text).slice(0, 32768); });
  const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  try {
    assert.equal(JSON.parse(String((await bounded(lines.next(), "CLI original pidfd readiness")).value)).originalPidfd, true);
    if (stdout !== undefined) assert.equal(JSON.parse(String((await bounded(stdout.next(), "Actual CLI atomic snapshot")).value)).type, "snapshot");
    const start = performance.now(); child.stdin.end(`${action === "broken-output" ? "wait" : action}\n`);
    if (action === "broken-output") {
      child.stdout.destroy();
      await owned().commit(async tx => { await tx.appendEntry(owned().id, { kind: "client.fixture", data: { text: "p".repeat(64 * 1024) } }); }, BACKGROUND_CONTEXT);
    }
    const ended = await bounded(lines.next(), "CLI finite exit", 18000);
    await writeFile(join(root, `cli-${action}.stderr`), stderr, { flag: "wx", mode: 0o600 });
    assert.equal(ended.done, false, `CLI ${action} custody ended without receipt: ${stderr}`);
    const result = JSON.parse(String(ended.value)); assert.equal(result.code, 1); assert.equal(result.originalPidfdClosed, true);
    assert.equal(await bounded(exit, "CLI custody join"), 0, stderr); assert.ok(stderrBytes < 32768, "CLI stderr exceeded its diagnostic budget");
    if (action === "broken-output") { assert.match(stderr, /Client output ended/); return Math.round(performance.now() - start); }
    if (action === "wait") { assert.match(stderr, /Client output did not drain; viewer detached/); return Math.round(performance.now() - start); }
    assert.match(stderr, /No cancellation was sent/); process.stderr.write(`${JSON.stringify({ cliCase: action, exited: true })}\n`); return Math.round(performance.now() - start);
  } finally { child.stdin.end(); child.stdout.destroy(); await bounded(exit, "CLI custody cleanup join", 18000); await stdout?.return?.(); await lines.return?.(); }
}
try {
  await closedStderr();
  host = await DurableHost.open(config, models); const ingress = await ClientServer.open(host); endpoint = ingress.endpoint;
  for await (const message of clientMessages(await post("open", "open"), "open")) assert.equal(message.kind, "reply");
  Object.defineProperty(globalThis, "setTimeout", { ...timerDescriptor, value: function<Args extends unknown[]>(callback: (...args: Args) => void, ms?: number, ...args: Args) { return nativeTimer(callback, ms === CLIENT_RESOURCES.viewerMs ? 50 : ms, ...args); } });
  const expiry: ClientMessage[] = [];
  try { for await (const message of clientMessages(await post("expiry", "watch"), "expiry")) expiry.push(message); }
  finally { Object.defineProperty(globalThis, "setTimeout", timerDescriptor); process.stderr.write(`${JSON.stringify({ expiryFrames: expiry.map(message => message.kind) })}\n`); }
  assert.equal(expiry[0]?.kind, "event"); assert.deepEqual(expiry.at(-1), { kind: "end", reason: "retired" }, "Planned viewer expiry must send a truthful terminal frame");
  await cliViewer("SIGINT"); await cliViewer("SIGTERM"); await cliViewer("broken-output");
  await owned().commit(async tx => { await tx.appendEntry(owned().id, { kind: "client.fixture", data: { text: "x".repeat(6 * 1024 * 1024) } }); }, BACKGROUND_CONTEXT);
  const cliDrainMs = await cliViewer("wait"); assert.ok(cliDrainMs >= CLIENT_RESOURCES.backpressureMs - 500 && cliDrainMs <= CLIENT_RESOURCES.backpressureMs + 3000);
  Object.defineProperty(ServerResponse.prototype, "write", { configurable: true, get(this: ServerResponse) { if (captureSlow) { captureSlow = false; slowStarted = performance.now(); this.once("close", () => slowRequestClosed.resolve()); } return nativeWrite; } });
  captureSlow = true;
  const responseReady = Promise.withResolvers<void>();
  const slow = request(`${endpoint}/v1`, { method: "POST", headers: { "content-type": "application/json", authorization } }, response => { slowResponse = response; response.on("error", () => undefined); response.pause(); responseReady.resolve(); });
  slow.once("error", error => responseReady.reject(error));
  slow.end(JSON.stringify({ v: 1, id: "slow-reader", operation: { op: "watch", workspaceId: "coding" } }));
  try {
    await bounded(responseReady.promise, "Paused TCP reader headers");
    for await (const message of clientMessages(await post("during-slow", "status"), "during-slow")) assert.equal(message.kind, "reply");
    await bounded(slowRequestClosed.promise, "Backpressured server writer retirement");
    const slowMs = Math.round(performance.now() - slowStarted);
    assert.ok(slowMs >= CLIENT_RESOURCES.backpressureMs - 500); assert.ok(slowMs <= CLIENT_RESOURCES.backpressureMs + 3000);
    await owned().commit(async tx => { await tx.appendEntry(owned().id, { kind: "client.fixture", data: { text: "y".repeat(3 * 1024 * 1024) } }); }, BACKGROUND_CONTEXT);
    for (const id of ["oversized-1", "oversized-2", "oversized-3"]) {
      const response = await post(id, "watch"); assert.equal(response.status, 413); assert.equal(response.headers.get("content-type"), "application/json");
      const messages: ClientMessage[] = []; for await (const message of clientMessages(response, id)) messages.push(message);
      assert.equal(messages.length, 1); assert.equal(messages[0]?.kind, "error");
      const error = messages[0]; assert.ok(error?.kind === "error"); assert.equal(error.code, "view_too_large");
    }
    for await (const message of clientMessages(await post("open-event", "open", "event"), "open-event")) assert.equal(message.kind, "reply");
    const live = clientMessages(await post("large-event", "watch", "event"), "large-event");
    const baseline = await bounded(live.next(), "Actual live baseline"); assert.equal(baseline.value?.kind, "event");
    await owned().commit(async tx => { await tx.appendEntry(owned().id, { kind: "client.fixture", data: { text: "z".repeat(9 * 1024 * 1024) } }); }, BACKGROUND_CONTEXT);
    const terminal = await bounded(live.next(), "Oversized committed event refusal"); assert.ok(terminal.value?.kind === "error"); assert.equal(terminal.value.code, "view_too_large"); assert.equal((await live.next()).done, true);
    assert.equal(opens, 2); assert.equal(faux.state.callCount, 0);
    const result = { proof: "client-resource-lifetimes", root, opens, providerCalls: faux.state.callCount, acceleratedActualViewerTimer: true, plannedExpiryRetired: true, actualPausedTcpReader: true, slowReaderRetirementMs: slowMs, cliOriginalPidfdSignals: ["SIGINT", "SIGTERM"], cliPausedStdoutRetirementMs: cliDrainMs, cliBrokenOutputRetired: true, closedStderrWithoutUncaught: true, concurrentStatusNotBusy: true, actualSdkEntryBytes: 18 * 1024 * 1024 + 64 * 1024, oversizedBaselineRefusedBeforeSse: true, oversizedCommittedEventRefused: true, sdkOverflowSnapshotAcceptance: false, failedViewerCapacityRetired: true, productionModel: false };
    await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600, flush: true }); process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { slowResponse?.destroy(); slow.destroy(); }
} finally {
  Object.defineProperty(globalThis, "setTimeout", timerDescriptor);
  if (writeDescriptor === undefined) Reflect.deleteProperty(ServerResponse.prototype, "write"); else Object.defineProperty(ServerResponse.prototype, "write", writeDescriptor);
  slowResponse?.destroy(); await host?.close(); Harness.open = originalOpen;
}
