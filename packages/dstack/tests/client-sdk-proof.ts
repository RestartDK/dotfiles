import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Harness, type Conversation } from "@earendil-works/pi-durable";
import { ClientError, clientToken, newClientCredential } from "#client-authority";
import { parseClientOperation } from "#client-protocol";
import { ClientCursorError, ClientHistory } from "#client-history";
import { CLIENT_RESOURCES, clientFrame } from "#client-wire";
import { DurableHost, type ClientObservation } from "#durable-host";
import { parseHostConfig } from "#host-protocol";

const root = await mkdtemp(join(tmpdir(), "client-sdk-"));
process.stderr.write(`${JSON.stringify({ fixture: "client-sdk", root })}\n`);
const cwd = join(root, "workspace"), other = join(root, "other");
await mkdir(cwd, { mode: 0o700 }); await mkdir(other, { mode: 0o700 });
const identity = { deploymentId: "client-sdk-proof", domain: "personal", nodeId: "fixture" } satisfies Parameters<typeof newClientCredential>[0]["identity"];
const writer = newClientCredential({ identity, principalId: "writer" });
const reader = newClientCredential({ identity, principalId: "reader" });
const second = newClientCredential({ identity, principalId: "second" });
const credentials = [writer, reader, second];
for (const credential of credentials) await writeFile(join(root, `${credential.principalId}.key`), JSON.stringify(credential), { mode: 0o600, flag: "wx", flush: true });
const config = parseHostConfig({
  identity, stateRoot: join(root, "state"), model: { provider: "client-sdk-fixture", modelId: "text" }, thinkingLevel: "off", authPath: join(root, "unused-auth"), modelsPath: join(root, "unused-models"),
  execution: { mode: "durable", maxRecords: 256, clients: { version: 1, listen: { host: "127.0.0.1", port: 0 }, workspaces: [{ workspaceId: "coding", cwd }, { workspaceId: "other", cwd: other }], grants: credentials.map(credential => ({ principalId: credential.principalId, tokenFile: join(root, `${credential.principalId}.key`), workspaces: [{ workspaceId: "coding", permissions: credential === reader ? ["read"] : ["read", "submit", "abort", "command.cancel"] }] })) } },
});
const response = "Committed public SDK progress reaches this authorized viewer. Detaching the viewer must not cancel the generation, submit again, or create another SDK owner.";
const faux = fauxProvider({ api: "client-sdk-fixture", provider: "client-sdk-fixture", models: [{ id: "text", input: ["text"] }], tokensPerSecond: 80, tokenSize: { min: 4, max: 4 } });
faux.setResponses([fauxAssistantMessage(response), fauxAssistantMessage("This explicitly stopped generation must not finish. ".repeat(100))]);
const models = createModels(); models.setProvider(faux.provider);
let opens = 0, sdkCalls = 0;
let conversation: Conversation | undefined;
const originalOpen = Harness.open;
Harness.open = async (...args) => {
  opens += 1;
  const harness = await originalOpen(...args);
  const commit = harness.commit.bind(harness), snapshot = harness.snapshot.bind(harness), lookup = harness.conversation.bind(harness), rootConversation = harness.root.bind(harness);
  harness.commit = (change, context) => { sdkCalls += 1; return commit(change, context); };
  Object.defineProperty(harness, "snapshot", { configurable: true, get() { sdkCalls += 1; return snapshot; } });
  harness.conversation = (id, context) => { sdkCalls += 1; return lookup(id, context); };
  harness.root = async (...parameters) => { conversation = await rootConversation(...parameters); return conversation; };
  return harness;
};
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function ownedConversation(): Conversation { assert.ok(conversation); return conversation; }
function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10000); })]).finally(() => clearTimeout(timer));
}
let host: DurableHost | undefined;
const views = new Set<ClientObservation>();
const events: string[] = [];
const callbackReleased = Promise.withResolvers<void>();
async function request(token: string, operation: unknown) {
  assert.ok(host);
  return host.client({ token, operation: parseClientOperation(operation) });
}
async function reply(token: string, operation: unknown) {
  const result = await request(token, operation); assert.equal(result.kind, "reply");
  assert.ok(result.kind === "reply"); return object(JSON.parse(clientFrame(result.result)));
}
async function watch(token: string) {
  const result = await request(token, { op: "watch", workspaceId: "coding" });
  assert.ok(result.kind === "watch"); views.add(result.observation); return result.observation;
}
try {
  host = await DurableHost.open(config, models);
  const beforeOpen = sdkCalls;
  await assert.rejects(request("invalid", { op: "open", workspaceId: "coding" }), ClientError);
  assert.equal(opens, 0); assert.equal(sdkCalls, beforeOpen);
  const opened = await reply(clientToken(writer), { op: "open", workspaceId: "coding" });
  assert.equal(opens, 1); assert.equal(opened.conversationId, String(ownedConversation().id));
  const deniedAt = sdkCalls;
  for (const op of ["open", "abort", "command.cancel", "submit"]) {
    const operation = op === "submit" ? { op, workspaceId: "coding", requestId: "denied", content: "Never infer" } : op === "command.cancel" ? { op, workspaceId: "coding", intentId: "guessed" } : { op, workspaceId: "coding" };
    await assert.rejects(request(clientToken(reader), operation), error => error instanceof ClientError && error.code === "scope_denied");
  }
  await assert.rejects(request(clientToken(writer), { op: "watch", workspaceId: "other" }), error => error instanceof ClientError && error.code === "scope_denied");
  assert.equal(sdkCalls, deniedAt); assert.equal(faux.state.callCount, 0); assert.equal(opens, 1);
  const first = await watch(clientToken(reader)), secondView = await watch(clientToken(reader));
  assert.equal(Object.hasOwn(first.snapshot, "seq"), false); assert.equal(Object.hasOwn(first.snapshot, "sequence"), false);
  await assert.rejects(watch(clientToken(reader)), /Client observation limit/);
  await reply(clientToken(writer), { op: "status", workspaceId: "coding", requestId: "absent" });
  const progress = Promise.withResolvers<void>();
  first.start(async event => { events.push(event.type); if (event.type === "message_update") { progress.resolve(); await callbackReleased.promise; } });
  const admitted = await reply(clientToken(writer), { op: "submit", workspaceId: "coding", requestId: "turn", content: "Return the fixture response" });
  await bounded(progress.promise, "Committed progress");
  let stopped = false;
  const stoppingFirst = first.stop().then(end => { stopped = true; return end; });
  await nextTurn(); assert.equal(stopped, false, "Client stop must join its already-running listener, not just public SDK closed");
  callbackReleased.resolve(); await stoppingFirst; await secondView.stop(); views.clear();
  await bounded(ownedConversation().waitForIdle(BACKGROUND_CONTEXT), "Detached completion");
  const done = await reply(clientToken(writer), { op: "status", workspaceId: "coding", requestId: "turn" });
  assert.equal(object(done.receipt).status, "done"); assert.equal(typeof object(done.receipt).id, "string");
  const overflow = await watch(clientToken(reader)), replacement = Promise.withResolvers<ClientObservation["snapshot"]>();
  for (let i = 0; i < 102; i += 1) await ownedConversation().commit(async tx => { await tx.appendEntry(ownedConversation().id, { kind: "client.overflow", data: { ordinal: i } }); }, BACKGROUND_CONTEXT);
  overflow.start(async event => { if (event.type === "snapshot") replacement.resolve(event); });
  const atomicReplacement = await bounded(replacement.promise, "Actual SDK watch overflow snapshot");
  assert.ok(atomicReplacement.entries.filter(entry => entry.kind === "client.overflow").length >= 101);
  assert.equal(Object.hasOwn(atomicReplacement, "seq"), false); assert.equal(Object.hasOwn(atomicReplacement, "sequence"), false);
  await overflow.stop(); views.delete(overflow); assert.equal(faux.state.callCount, 1);
  const retried = await reply(clientToken(writer), { op: "submit", workspaceId: "coding", requestId: "turn", content: "Return the fixture response" });
  assert.equal(object(retried.receipt).id, object(admitted.receipt).id);
  await assert.rejects(reply(clientToken(writer), { op: "submit", workspaceId: "coding", requestId: "turn", content: "Changed payload" }), /Request ID is already bound/);
  assert.equal((await reply(clientToken(second), { op: "status", workspaceId: "coding", requestId: "turn" })).receipt, null);
  assert.equal(faux.state.callCount, 1);
  await ownedConversation().commit(async tx => { for (let i = 0; i < 35; i += 1) await tx.appendEntry(ownedConversation().id, { kind: "client.fixture", data: { label: String(i) } }); }, BACKGROUND_CONTEXT);
  const actualPage = await ownedConversation().entries({ order: "descending" }, 20, undefined, BACKGROUND_CONTEXT);
  assert.ok(actualPage.next);
  const configured = config.execution?.clients?.workspaces.find(workspace => workspace.workspaceId === "coding"); assert.ok(configured);
  const scope = { principalId: "reader", workspaceId: configured.workspaceId, conversationId: String(ownedConversation().id) };
  const cache = new ClientHistory(identity), wallClock = Date.now, now = wallClock();
  try {
    Date.now = () => now;
    const expiring = cache.seal(actualPage.next, scope); assert.ok(expiring);
    assert.equal(cache.read(expiring, scope), actualPage.next);
    Date.now = () => now + CLIENT_RESOURCES.cursorMs - 1; assert.equal(cache.read(expiring, scope), actualPage.next);
    Date.now = () => now + CLIENT_RESOURCES.cursorMs; assert.throws(() => cache.read(expiring, scope), ClientCursorError);
    const firstSlot = cache.seal(actualPage.next, scope); assert.ok(firstSlot);
    let newest = firstSlot;
    for (let slot = 1; slot < CLIENT_RESOURCES.cursorSlots; slot += 1) { const token = cache.seal(actualPage.next, scope); assert.ok(token); newest = token; }
    assert.equal(cache.read(firstSlot, scope), actualPage.next);
    const overflow = cache.seal(actualPage.next, scope); assert.ok(overflow);
    assert.throws(() => cache.read(firstSlot, scope), ClientCursorError);
    assert.equal(cache.read(newest, scope), actualPage.next); assert.equal(cache.read(overflow, scope), actualPage.next);
    assert.throws(() => cache.read(overflow, { ...scope, conversationId: "guessed-conversation" }), ClientCursorError);
  } finally { Date.now = wallClock; }
  const page = await reply(clientToken(reader), { op: "snapshot", workspaceId: "coding" });
  assert.equal(typeof page.cursor, "string"); assert.ok(typeof page.cursor === "string");
  const cursor = page.cursor;
  const atCursorRefusal = sdkCalls;
  await assert.rejects(reply(clientToken(second), { op: "snapshot", workspaceId: "coding", cursor }), ClientCursorError);
  assert.equal(sdkCalls, atCursorRefusal);
  const continued = await reply(clientToken(reader), { op: "snapshot", workspaceId: "coding", cursor });
  const actualNext = await ownedConversation().entries({ order: "descending" }, 20, actualPage.next, BACKGROUND_CONTEXT);
  assert.ok(Array.isArray(continued.entries)); assert.deepEqual(continued.entries.map(entry => object(entry).id), actualNext.items.map(entry => String(entry.id)));
  assert.equal(JSON.stringify(continued).includes("client.v1."), false);
  await host.close(); host = undefined;
  const rotated = newClientCredential({ identity, principalId: "writer" });
  await writeFile(join(root, "writer.key"), JSON.stringify(rotated), { mode: 0o600, flush: true });
  host = await DurableHost.open(config, models);
  const restartAt = sdkCalls;
  await assert.rejects(reply(clientToken(writer), { op: "status", workspaceId: "coding", requestId: "turn" }), ClientError);
  await assert.rejects(reply(clientToken(reader), { op: "snapshot", workspaceId: "coding", cursor }), ClientCursorError);
  assert.equal(sdkCalls, restartAt);
  assert.equal(object((await reply(clientToken(rotated), { op: "status", workspaceId: "coding", requestId: "turn" })).receipt).id, object(done.receipt).id);
  const reopened = await watch(clientToken(reader));
  assert.equal(reopened.snapshot.generation, undefined); assert.equal(JSON.stringify(reopened.snapshot.entries).includes(response), true); assert.equal(faux.state.callCount, 1);
  await reopened.stop(); views.clear();
  const stopping = await watch(clientToken(reader)), abortProgress = Promise.withResolvers<void>();
  stopping.start(async event => { if (event.type === "message_update") abortProgress.resolve(); });
  await reply(clientToken(rotated), { op: "submit", workspaceId: "coding", requestId: "abort", content: "Begin a long response for explicit SDK stop" });
  await bounded(abortProgress.promise, "Abort progress");
  assert.equal((await bounded(reply(clientToken(rotated), { op: "abort", workspaceId: "coding" }), "SDK abort")).ordinarySdkWorkStopped, true);
  assert.equal(object((await reply(clientToken(rotated), { op: "status", workspaceId: "coding", requestId: "abort" })).receipt).status, "unanswered");
  const shutdown: string[] = [];
  host.registerClientIngress({ seal() { shutdown.push("seal"); }, async close() { shutdown.push("drain"); } });
  await bounded(host.close(), "Host close with viewer"); host = undefined;
  assert.equal((await stopping.closed).reason, "stopped"); views.clear(); assert.deepEqual(shutdown, ["seal", "drain"]);
  const result = { proof: "client-sdk-owner", root, opens, providerCalls: faux.state.callCount, events, deniedBeforeSdk: true, oneOwnerPerBoot: opens === 2, detachedGenerationCompleted: true, originalPublicCursorPaging: true, originalCursorTTLAndSlotEviction: true, actualSdkOverflowAtomicSnapshot: true, restartExpiresCursor: true, rotationPreservesRequest: true, explicitOrdinarySdkAbort: true, hostClosesViewer: true, stopJoinsOwnedListener: true, httpAcceptance: false, productionModelAcceptance: false };
  assert.equal(opens, 2); assert.equal(faux.state.callCount, 2);
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx", flush: true }); process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { callbackReleased.resolve(); for (const view of views) await view.stop(); await host?.close(); Harness.open = originalOpen; }
