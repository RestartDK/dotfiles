import assert from "node:assert/strict";
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
const root = await mkdtemp(join(tmpdir(), "client-resources-")), cwd = join(root, "workspace"); await mkdir(cwd, { mode: 0o700 });
process.stderr.write(`${JSON.stringify({ fixture: "client-resources", root })}\n`);
const identity = { deploymentId: "client-resources", domain: "personal", nodeId: "fixture" } satisfies Parameters<typeof newClientCredential>[0]["identity"];
const credential = newClientCredential({ identity, principalId: "writer" }), tokenFile = join(root, "writer.key");
await writeFile(tokenFile, JSON.stringify(credential), { flag: "wx", mode: 0o600, flush: true });
const config = parseHostConfig({ identity, stateRoot: join(root, "state"), model: { provider: "client-resources", modelId: "text" }, thinkingLevel: "off", authPath: join(root, "unused-auth"), modelsPath: join(root, "unused-models"), execution: { mode: "durable", maxRecords: 256, clients: { version: 1, listen: { host: "127.0.0.1", port: 0 }, workspaces: [{ workspaceId: "coding", cwd }], grants: [{ principalId: "writer", tokenFile, workspaces: [{ workspaceId: "coding", permissions: ["read", "submit"] }] }] } } });
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
function post(id: string, op: string): Promise<Response> { return fetch(`${endpoint}/v1`, { method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify({ v: 1, id, operation: { op, workspaceId: "coding", ...(op === "status" ? { requestId: "absent" } : {}) } }) }); }
try {
  host = await DurableHost.open(config, models); const ingress = await ClientServer.open(host); endpoint = ingress.endpoint;
  for await (const message of clientMessages(await post("open", "open"), "open")) assert.equal(message.kind, "reply");
  Object.defineProperty(globalThis, "setTimeout", { ...timerDescriptor, value: function<Args extends unknown[]>(callback: (...args: Args) => void, ms?: number, ...args: Args) { return nativeTimer(callback, ms === CLIENT_RESOURCES.viewerMs ? 50 : ms, ...args); } });
  const expiry: ClientMessage[] = [];
  try { for await (const message of clientMessages(await post("expiry", "watch"), "expiry")) expiry.push(message); }
  finally { Object.defineProperty(globalThis, "setTimeout", timerDescriptor); process.stderr.write(`${JSON.stringify({ expiryFrames: expiry.map(message => message.kind) })}\n`); }
  assert.equal(expiry[0]?.kind, "event"); assert.deepEqual(expiry.at(-1), { kind: "end", reason: "retired" }, "Planned viewer expiry must send a truthful terminal frame");
  await owned().commit(async tx => { await tx.appendEntry(owned().id, { kind: "client.fixture", data: { text: "x".repeat(6 * 1024 * 1024) } }); }, BACKGROUND_CONTEXT);
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
    assert.equal(opens, 1); assert.equal(faux.state.callCount, 0);
    const result = { proof: "client-resource-lifetimes", root, opens, providerCalls: faux.state.callCount, acceleratedActualViewerTimer: true, plannedExpiryRetired: true, actualPausedTcpReader: true, slowReaderRetirementMs: slowMs, concurrentStatusNotBusy: true, actualSdkEntryBytes: 9 * 1024 * 1024, oversizedBaselineRefusedBeforeSse: true, failedViewerCapacityRetired: true, productionModel: false };
    await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600, flush: true }); process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { slowResponse?.destroy(); slow.destroy(); }
} finally {
  Object.defineProperty(globalThis, "setTimeout", timerDescriptor);
  if (writeDescriptor === undefined) Reflect.deleteProperty(ServerResponse.prototype, "write"); else Object.defineProperty(ServerResponse.prototype, "write", writeDescriptor);
  slowResponse?.destroy(); await host?.close(); Harness.open = originalOpen;
}
