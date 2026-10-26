import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Harness } from "@earendil-works/pi-durable";
import { newClientCredential } from "#client-authority";
import { DurableHost } from "#durable-host";
import { parseHostConfig, parseOperation } from "#host-protocol";

const root = await mkdtemp(join(tmpdir(), "client-host-"));
const cwd = join(root, "workspace"), other = join(root, "other"), stateRoot = join(root, "state"), tokenFile = join(cwd, "reader.key");
await mkdir(cwd, { mode: 0o700 }); await mkdir(other, { mode: 0o700 });
const identity = { deploymentId: "client-host-proof", domain: "personal", nodeId: "fixture" } satisfies Parameters<typeof newClientCredential>[0]["identity"];
const credential = newClientCredential({ identity, principalId: "reader" });
const credentialBytes = JSON.stringify(credential);
await writeFile(tokenFile, credentialBytes, { flag: "wx", mode: 0o600, flush: true });
const common = { identity, stateRoot, model: { provider: "host-fixture", modelId: "files" }, thinkingLevel: "off", authPath: join(root, "unused-auth.json"), modelsPath: join(root, "unused-models.json") };
const clients = { version: 1, listen: { host: "127.0.0.1", port: 0 }, workspaces: [{ workspaceId: "coding", cwd }], grants: [{ principalId: "reader", tokenFile, workspaces: [{ workspaceId: "coding", permissions: ["read"] }] }] };
const config = parseHostConfig({ ...common, execution: { mode: "durable", maxRecords: 256, clients } });
const faux = fauxProvider({ api: "host-fixture", provider: "host-fixture", models: [{ id: "files", input: ["text"] }], tokenSize: { min: 4096, max: 4096 } });
const models = createModels(); models.setProvider(faux.provider);
let opens = 0;
const originalOpen = Harness.open;
Harness.open = async (...args) => { opens += 1; return originalOpen(...args); };
let host: DurableHost | undefined;

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function binding() {
  const db = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  try {
    const bytes = db.prepare("SELECT value FROM binding WHERE id=1").get()?.value;
    assert.equal(typeof bytes, "string"); assert.ok(typeof bytes === "string");
    return object(JSON.parse(bytes));
  } finally { db.close(); }
}
async function done(active: DurableHost, requestId: string) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const status = object(await active.handle(parseOperation({ op: "status", workspaceId: "coding", requestId })));
    if (status.receipt !== null && object(status.receipt).status === "done") return;
    await delay(10);
  }
  throw new Error("Client token protection turn did not finish");
}

try {
  const invalidRoot = join(root, "unallocated");
  const invalid = parseHostConfig({ ...common, stateRoot: invalidRoot, execution: { mode: "durable", maxRecords: 256, clients: { ...clients, grants: [{ ...clients.grants[0], tokenFile: join(root, "absent.key") }] } } });
  await assert.rejects(DurableHost.open(invalid, models), /Client credential reference/);
  assert.equal(opens, 0); await assert.rejects(lstat(invalidRoot), { code: "ENOENT" });
  host = await DurableHost.open(config, models);
  assert.ok(host.clientAuthority); assert.equal(opens, 0);
  await assert.rejects(host.handle(parseOperation({ op: "create", workspaceId: "coding", requestId: "wrong-cwd", cwd: other })), /Configured client workspace cwd differs/);
  assert.equal(opens, 0);
  await host.handle(parseOperation({ op: "create", workspaceId: "coding", requestId: "create", cwd }));
  assert.equal(opens, 1);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "reader.key" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write", { path: "reader.key", content: "replacement" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("edit", { path: "reader.key", oldText: "reader", newText: "admin" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("All credential file access must be refused."),
  ]);
  await host.handle(parseOperation({ op: "submit", workspaceId: "coding", requestId: "token-protection", content: "Exercise real read/write/edit against the protected credential reference." }));
  await done(host, "token-protection");
  assert.equal(faux.state.callCount, 4);
  const snapshot = JSON.stringify(await host.handle(parseOperation({ op: "snapshot", workspaceId: "coding" })));
  assert.match(snapshot, /protected host control or authorization state/);
  assert.equal(snapshot.includes(credential.secret), false);
  assert.equal(await readFile(tokenFile, "utf8"), credentialBytes);
  assert.deepEqual(object(await host.handle(parseOperation({ op: "execution.status", workspaceId: "coding" }))).unresolved, []);
  await host.close(); host = undefined;
  assert.equal(binding().version, 3);
  const before = opens;
  const disabled = parseHostConfig({ ...common, execution: { mode: "durable", maxRecords: 256 } });
  await assert.rejects(DurableHost.open(disabled, models), /Host root identity differs/);
  assert.equal(opens, before); assert.equal(binding().version, 3);
  const retargeted = parseHostConfig({ ...common, execution: { mode: "durable", maxRecords: 256, clients: { ...clients, workspaces: [{ workspaceId: "coding", cwd: other }] } } });
  await assert.rejects(DurableHost.open(retargeted, models), /Configured client workspace cwd differs/);
  assert.equal(opens, before);
  host = await DurableHost.open(config, models);
  assert.equal(opens, before + 1); assert.equal(faux.state.callCount, 4);
  await host.close(); host = undefined;

  const old = process.env.DSTACK_CLIENT_OLD_FIXTURE;
  if (old !== undefined) {
    assert.ok(old.startsWith("/nix/store/")); await lstat(old);
    const bytes = JSON.stringify(disabled), configFile = join(root, "without-clients.json");
    await writeFile(configFile, bytes, { flag: "wx", mode: 0o600, flush: true });
    const result = spawnSync(process.execPath, [old, configFile], { encoding: "utf8", input: "", timeout: 15000, maxBuffer: 128 * 1024, env: { ...process.env, HERDR_DURABLE_HOST_CONFIG_SHA256: createHash("sha256").update(bytes).digest("hex") } });
    await writeFile(join(root, "actual-previous-owner.json"), JSON.stringify({ old, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }, null, 2), { flag: "wx", mode: 0o600, flush: true });
    assert.equal(result.status, 1); assert.equal(result.signal, null); assert.equal(result.error, undefined);
    assert.equal(result.stdout, ""); assert.match(result.stderr, /HostError: Host root identity differs/);
  }
  assert.equal(binding().version, 3); assert.equal(await readFile(tokenFile, "utf8"), credentialBytes);
  const result = { proof: "client-authority-host-component", root, bindingVersion: 3, invalidCredentialBeforeAllocationAndHarness: true, configuredCwdBeforeAdmission: true, actualModelReadWriteEditRefused: true, reopenDoesNotInfer: true, disabledCurrentBeforeHarness: true, actualPreviousOwnerRefused: old !== undefined, listenerAcceptance: false, productionModelAcceptance: false };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600, flush: true });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  Harness.open = originalOpen;
  await host?.close();
}
