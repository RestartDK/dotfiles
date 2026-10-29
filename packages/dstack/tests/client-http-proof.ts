import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { CLIENT_RESOURCES } from "#client-wire";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Harness, type Conversation } from "@earendil-works/pi-durable";
import { clientToken, loadClientCredential, newClientCredential } from "#client-authority";
import { ClientServer } from "#client-http";
import { MAX_CLIENT_REQUEST_BYTES } from "#client-protocol";
import { DurableHost } from "#durable-host";
import { parseHostConfig } from "#host-protocol";
import { serveHost } from "#host-stdio";

const root = await mkdtemp(join(tmpdir(), "client-http-"));
process.stderr.write(`${JSON.stringify({ fixture: "client-http", root })}\n`);
const cwd = join(root, "workspace"); await mkdir(cwd, { mode: 0o700 });
const identity = { deploymentId: "client-http-proof", domain: "personal", nodeId: "fixture" } satisfies Parameters<typeof newClientCredential>[0]["identity"];
async function cli(command: string, args: readonly string[], content = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../client-cli.js", import.meta.url)), command, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data: string) => { stdout += data; assert.ok(Buffer.byteLength(stdout) < 128 * 1024); });
  child.stderr.on("data", (data: string) => { stderr += data; assert.ok(Buffer.byteLength(stderr) < 128 * 1024); });
  child.stdin.end(content);
  return new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr })); });
}
for (const principal of ["writer", "reader"]) {
  const created = await cli("key", ["--deployment", identity.deploymentId, "--domain", identity.domain, "--node", identity.nodeId, "--principal", principal, "--out", join(root, `${principal}.key`)]);
  assert.equal(created.code, 0, created.stderr); assert.equal(JSON.parse(created.stdout).created, true);
}
const writer = await loadClientCredential(join(root, "writer.key")), readerCredential = await loadClientCredential(join(root, "reader.key"));
const duplicateKey = await cli("key", ["--deployment", identity.deploymentId, "--domain", identity.domain, "--node", identity.nodeId, "--principal", "writer", "--out", join(root, "writer.key")]);
assert.equal(duplicateKey.code, 1); assert.deepEqual(await loadClientCredential(join(root, "writer.key")), writer);
const config = parseHostConfig({ identity, stateRoot: join(root, "state"), model: { provider: "client-http-fixture", modelId: "text" }, thinkingLevel: "off", authPath: join(root, "unused-auth"), modelsPath: join(root, "unused-models"), execution: { mode: "durable", maxRecords: 256, clients: { version: 1, listen: { host: "127.0.0.1", port: 0 }, workspaces: [{ workspaceId: "coding", cwd }], grants: [writer, readerCredential].map(credential => ({ principalId: credential.principalId, tokenFile: join(root, `${credential.principalId}.key`), workspaces: [{ workspaceId: "coding", permissions: credential === writer ? ["read", "submit", "abort", "command.cancel"] : ["read"] }] })) } } });
const faux = fauxProvider({ api: "client-http-fixture", provider: "client-http-fixture", models: [{ id: "text", input: ["text"] }], tokensPerSecond: 80, tokenSize: { min: 4, max: 4 } });
faux.setResponses([fauxAssistantMessage("Committed progress comes from the actual owner. Disconnecting this HTTP viewer must not cancel its generation."), fauxAssistantMessage("The admitted submission survives the deliberately lost HTTP acknowledgment.")]);
const models = createModels(); models.setProvider(faux.provider);
let opens = 0, conversation: Conversation | undefined, onAdmitted: ((id: string) => void) | undefined;
let currentHarness: Awaited<ReturnType<typeof Harness.open>> | undefined, heldCommit: Promise<void> | undefined, onSnapshotRead: (() => void) | undefined;
const lookupHeld = Promise.withResolvers<void>(), lookupReleased = Promise.withResolvers<void>();
const raceController = new AbortController();
const originalOpen = Harness.open;
Harness.open = async (...args) => {
  opens += 1; const harness = await originalOpen(...args), rootConversation = harness.root.bind(harness), snapshot = harness.snapshot.bind(harness);
  currentHarness = harness;
  Object.defineProperty(harness, "snapshot", { configurable: true, get() { onSnapshotRead?.(); return snapshot; } });
  harness.root = async (...parameters) => {
    conversation = await rootConversation(...parameters);
    const submit = conversation.submit.bind(conversation);
    conversation.submit = async (...input) => { const admitted = await submit(...input); onAdmitted?.(String(admitted.id)); return admitted; };
    return conversation;
  };
  return harness;
};
function object(value: unknown): Record<string, unknown> { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return Object.fromEntries(Object.entries(value)); }
function owned(): Conversation { assert.ok(conversation); return conversation; }
function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 12000); })]).finally(() => clearTimeout(timer));
}
let host: DurableHost | undefined, endpoint = "", serial = 0;
let input = new PassThrough(); const output = new PassThrough(); output.resume();
let serving: Promise<void> | undefined;
const streams = new Set<ReadableStreamDefaultReader<Uint8Array>>();
async function call(operation: unknown, token = clientToken(writer), extra: Record<string, string> = {}, correlated = true) {
  const id = `http-${serial++}`;
  const response = await fetch(`${endpoint}/v1`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify({ v: 1, id, operation }) });
  const data = object(await response.json()); assert.equal(data.id, correlated ? id : null); return { response, data };
}
async function watch() {
  const response = await fetch(`${endpoint}/v1`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${clientToken(readerCredential)}`, origin: endpoint }, body: JSON.stringify({ v: 1, id: `watch-${serial++}`, operation: { op: "watch", workspaceId: "coding" } }) });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/); assert.ok(response.body);
  const reader = response.body.getReader(); streams.add(reader); let buffered = "";
  return { reader, async next() {
    for (;;) {
      const separator = buffered.indexOf("\n\n");
      if (separator !== -1) { const frame = buffered.slice(0, separator); buffered = buffered.slice(separator + 2); assert.ok(frame.startsWith("data: ")); return object(JSON.parse(frame.slice(6))); }
      const part = await reader.read(); assert.equal(part.done, false); if (part.done) throw new Error("Viewer closed before its expected frame");
      buffered += new TextDecoder().decode(part.value); assert.ok(Buffer.byteLength(buffered) <= 8 * 1024 * 1024);
    }
  } };
}
try {
  host = await DurableHost.open(config, models); endpoint = (await ClientServer.open(host)).endpoint;
  serving = serveHost(host, input, output);
  const idle = connect({ host: "127.0.0.1", port: Number(new URL(endpoint).port) }), idleStarted = performance.now();
  const idleClosed = new Promise<void>(resolve => idle.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => { idle.once("connect", resolve); idle.once("error", reject); });
    await bounded(idleClosed, "Empty unauthenticated connection header deadline");
    const idleMs = performance.now() - idleStarted;
    assert.ok(idleMs >= CLIENT_RESOURCES.requestMs - CLIENT_RESOURCES.headerCheckMs);
    assert.ok(idleMs <= CLIENT_RESOURCES.requestMs + CLIENT_RESOURCES.headerCheckMs * 3); assert.equal(opens, 0);
  } finally { idle.destroy(); }
  const page = await fetch(endpoint); assert.equal(page.status, 200); assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/); assert.equal(page.headers.has("access-control-allow-origin"), false); await page.text();
  assert.equal((await call({ op: "open", workspaceId: "coding" }, "invalid")).response.status, 401); assert.equal(opens, 0);
  assert.equal((await call({ op: "discover" }, clientToken(writer), { origin: "https://other.invalid" }, false)).response.status, 403);
  const badHost = await new Promise<{ status: number | undefined; data: Record<string, unknown> }>((resolve, reject) => {
    const request = httpRequest(`${endpoint}/v1`, { method: "POST", headers: { host: "other.invalid", "content-type": "application/json", authorization: `Bearer ${clientToken(writer)}` } }, response => {
      const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => { try { resolve({ status: response.statusCode, data: object(JSON.parse(Buffer.concat(chunks).toString("utf8"))) }); } catch (error) { reject(error); } });
    });
    request.once("error", reject); request.end(JSON.stringify({ v: 1, id: "wrong-host", operation: { op: "discover" } }));
  });
  assert.equal(badHost.status, 403); assert.equal(badHost.data.id, null); assert.equal(object(badHost.data.error).code, "invalid_host");
  const malformed = await call({ op: "open", workspaceId: "coding", actor: "admin" }); assert.equal(malformed.response.status, 400); assert.equal(object(malformed.data.error).code, "invalid_request");
  const oversized = await fetch(`${endpoint}/v1`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(MAX_CLIENT_REQUEST_BYTES + 1) }); assert.equal(oversized.status, 413); await oversized.text();
  assert.equal((await call({ op: "discover" })).response.status, 200); assert.equal(opens, 0);
  process.stderr.write("http-negative-admission-passed\n");
  const cliArgs = ["--endpoint", endpoint, "--credential", join(root, "writer.key")], cliWorkspace = [...cliArgs, "--workspace", "coding"];
  const discovered = await cli("discover", cliArgs); assert.equal(discovered.code, 0, discovered.stderr); assert.equal(object(JSON.parse(discovered.stdout)).principalId, "writer");
  assert.equal((await cli("open", [...cliWorkspace, "--actor", "admin"])).code, 1); assert.equal(opens, 0);
  const opened = await cli("open", cliWorkspace); assert.equal(opened.code, 0, opened.stderr); assert.equal(opens, 1);
  assert.equal((await call({ op: "submit", workspaceId: "coding", requestId: "denied", content: "Never infer" }, clientToken(readerCredential))).response.status, 403); assert.equal(faux.state.callCount, 0);
  const viewer = await watch(); const baseline = object((await bounded(viewer.next(), "Initial snapshot")).event);
  assert.equal(baseline.type, "snapshot"); assert.equal(Object.hasOwn(baseline, "seq"), false);
  const submitted = await cli("submit", [...cliWorkspace, "--request", "streamed"], "Return the streaming fixture response"); assert.equal(submitted.code, 0, submitted.stderr);
  const cliSubmissionId = object(object(JSON.parse(submitted.stdout)).receipt).id; assert.equal(typeof cliSubmissionId, "string");
  await bounded((async () => { for (;;) if (object((await viewer.next()).event).type === "message_update") return; })(), "Committed HTTP progress");
  await viewer.reader.cancel(); streams.delete(viewer.reader); await bounded(owned().waitForIdle(BACKGROUND_CONTEXT), "Disconnected generation");
  assert.equal(object(object((await call({ op: "status", workspaceId: "coding", requestId: "streamed" })).data.result).receipt).status, "done"); assert.equal(faux.state.callCount, 1);
  const cliStatus = await cli("status", [...cliWorkspace, "--request", "streamed"]); assert.equal(cliStatus.code, 0, cliStatus.stderr);
  const cliReceipt = object(object(JSON.parse(cliStatus.stdout)).receipt); assert.equal(cliReceipt.id, cliSubmissionId); assert.equal(cliReceipt.status, "done");
  const cliSnapshot = await cli("snapshot", ["--endpoint", endpoint, "--credential", join(root, "reader.key"), "--workspace", "coding"]); assert.equal(cliSnapshot.code, 0, cliSnapshot.stderr); assert.ok(Array.isArray(object(JSON.parse(cliSnapshot.stdout)).entries));
  const cliAbort = await cli("abort", cliWorkspace); assert.equal(cliAbort.code, 0, cliAbort.stderr); assert.equal(object(JSON.parse(cliAbort.stdout)).ordinarySdkWorkStopped, true);
  assert.equal(faux.state.callCount, 1); assert.equal(opens, 1);
  process.stderr.write("http-progress-detach-passed\n");
  const admitted = Promise.withResolvers<string>();
  const lost = httpRequest(`${endpoint}/v1`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${clientToken(writer)}` } });
  const disconnected = new Promise<void>(resolve => lost.once("error", () => resolve()));
  onAdmitted = id => { onAdmitted = undefined; lost.destroy(); admitted.resolve(id); };
  lost.end(JSON.stringify({ v: 1, id: "deliberately-lost", operation: { op: "submit", workspaceId: "coding", requestId: "lost", content: "The ACK will be lost after actual SDK admission" } }));
  const actualSubmission = await bounded(admitted.promise, "Actual SDK admission"); await bounded(disconnected, "Lost ACK socket close");
  await bounded(owned().waitForIdle(BACKGROUND_CONTEXT), "Lost ACK completion");
  const recovered = object(object((await call({ op: "status", workspaceId: "coding", requestId: "lost" })).data.result).receipt); assert.equal(recovered.id, actualSubmission); assert.equal(recovered.status, "done");
  const attached = await call({ op: "submit", workspaceId: "coding", requestId: "lost", content: "The ACK will be lost after actual SDK admission" }); assert.equal(object(object(attached.data.result).receipt).id, actualSubmission); assert.equal(faux.state.callCount, 2);
  process.stderr.write("http-lost-ack-passed\n");
  const reconnect = await watch(); assert.equal(object((await reconnect.next()).event).type, "snapshot"); assert.equal(faux.state.callCount, 2);
  input.end(); await bounded(serving, "Stdio EOF closes ingress and viewer"); serving = undefined; host = undefined;
  process.stderr.write("http-eof-closed\n");
  const terminal = await bounded(reconnect.next(), "EOF viewer terminal event"); assert.equal(terminal.end, "stopped");
  assert.equal((await bounded(reconnect.reader.read(), "EOF viewer stream end")).done, true);
  await assert.rejects(fetch(endpoint)); await reconnect.reader.cancel(); streams.clear();
  host = await DurableHost.open(config, models);
  const ingress = await ClientServer.open(host); endpoint = ingress.endpoint;
  const sealed = Promise.withResolvers<void>(), seal = ingress.seal.bind(ingress);
  ingress.seal = () => { seal(); sealed.resolve(); };
  input = new PassThrough(); const raceOutput = new PassThrough(); raceOutput.resume(); serving = serveHost(host, input, raceOutput);
  assert.ok(currentHarness);
  const lineHeld = Promise.withResolvers<void>();
  heldCommit = currentHarness.commit(async () => { lineHeld.resolve(); await lookupReleased.promise; }, BACKGROUND_CONTEXT);
  await bounded(lineHeld.promise, "Fixture holds the real SDK commit line");
  onSnapshotRead = () => { onSnapshotRead = undefined; lookupHeld.resolve(); };
  const lateWatch = fetch(`${endpoint}/v1`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${clientToken(readerCredential)}` }, signal: raceController.signal, body: JSON.stringify({ v: 1, id: "attaching-at-eof", operation: { op: "watch", workspaceId: "coding" } }) }).then(async response => {
    assert.equal(response.status, 503); const frame = object(await response.json());
    assert.equal(frame.id, "attaching-at-eof"); assert.equal(object(frame.error).code, "unavailable"); return true;
  }, (_error: unknown) => false);
  await bounded(lookupHeld.promise, "Admitted watch reaches actual SDK ownership read"); process.stderr.write("http-late-watch-sdk-read-held\\n");
  const busy = await call({ op: "status", workspaceId: "coding", requestId: "lost" });
  assert.equal(busy.response.status, 409); assert.equal(object(busy.data.error).code, "busy"); assert.equal(opens, 2);
  input.end(); await bounded(sealed.promise, "Stdio EOF seals late attachment"); process.stderr.write("http-late-watch-admission-sealed\\n");
  lookupReleased.resolve(); await bounded(serving, "Stdio EOF drains an admitted watch still attaching"); serving = undefined; host = undefined;
  assert.equal(await lateWatch, true); assert.equal(opens, 2); assert.equal(faux.state.callCount, 2); await assert.rejects(fetch(endpoint));
  const result = { proof: "client-http-owner", root, endpoint, opens, providerCalls: faux.state.callCount, strictHostOrigin: true, noHeaderConnectionDeadline: true, invalidInputNonfatal: true, correlatedMalformedOperation: true, actualSdkProgress: true, disconnectDoesNotCancel: true, actualPostAdmissionAckLost: true, sameSubmissionAfterLostAck: true, freshSnapshotReconnect: true, concurrentBusyIsCorrelatedAndNonfatal: true, stdioEofClosesListener: true, stdioEofDuringAdmittedWatchOwnershipRead: true, actualCliKeyDiscoverOpenSubmitStatusSnapshotAndIdleAbort: true, browserAcceptance: false, slowReaderAcceptance: false, productionModelAcceptance: false };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600, flush: true }); process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { onAdmitted = undefined; onSnapshotRead = undefined; lookupReleased.resolve(); raceController.abort(); await heldCommit; for (const stream of streams) await stream.cancel().catch(() => undefined); input.end(); await serving; await host?.close(); Harness.open = originalOpen; }
