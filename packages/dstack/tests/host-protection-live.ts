import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Harness } from "@earendil-works/pi-durable";
import { clientToken, newClientCredential } from "#client-authority";
import { parseClientOperation } from "#client-protocol";
import { DurableHost } from "#durable-host";
import { loadHostConfig, parseHostConfig, parseOperation } from "#host-protocol";
import { productionControlPaths } from "../src/host-protection.js";

process.umask(0o077);
const root = await mkdtemp(join(tmpdir(), "host-protection-")), configRoot = join(root, ".config/herdr-durable/personal"), stateRoot = join(root, ".local/state/herdr-durable/personal/owner"), jobs = join(root, ".local/state/dstack"), agent = join(root, ".pi/agent"), policy = join(root, ".config/dstack");
for (const path of [configRoot, jobs, join(jobs, "sessions"), agent, policy]) await mkdir(path, { recursive: true, mode: 0o700 });
const identity = { deploymentId: "production-protection", domain: "personal", nodeId: "fixture" } satisfies Parameters<typeof newClientCredential>[0]["identity"];
const credential = newClientCredential({ identity, principalId: "operator" }), tokenFile = join(configRoot, "operator.key"), configFile = join(configRoot, "host.json");
await writeFile(tokenFile, JSON.stringify(credential), { flag: "wx", mode: 0o600 });
const config = parseHostConfig({ identity, stateRoot, model: { provider: "host-fixture", modelId: "files" }, thinkingLevel: "off", authPath: join(agent, "auth.json"), modelsPath: join(policy, "models.json"), execution: { mode: "durable", maxRecords: 256, clients: { version: 1, listen: { host: "127.0.0.1", port: 23456 }, workspaces: [{ workspaceId: "coding", cwd: root }], grants: [{ principalId: "operator", tokenFile, workspaces: [{ workspaceId: "coding", permissions: ["read", "submit"] }] }] } } });
await writeFile(configFile, JSON.stringify(config), { flag: "wx", mode: 0o600 });
const prStore = join(jobs, "jobs.sqlite");
const targets = [prStore, join(jobs, "sessions/wake.json"), join(agent, "auth.previous.json"), config.modelsPath, join(configRoot, "rotated-old.key"), configFile];
const marker = "private-control-marker-not-for-models";
const database = new DatabaseSync(prStore);
database.exec("CREATE TABLE control_marker (value TEXT)"); database.prepare("INSERT INTO control_marker VALUES (?)").run(marker); database.close();
for (const path of targets.slice(1, -1)) await writeFile(path, JSON.stringify({ marker }), { flag: "wx", mode: 0o600 });
await writeFile(config.authPath, "{}", { flag: "wx", mode: 0o600 });
await chmod(configFile, 0o1600); assert.equal((await lstat(configFile)).mode & 0o7777, 0o1600);
await assert.rejects(loadHostConfig({ path: configFile, expectedSha256: undefined, access: "private-runtime" }), /private owned regular file/);
await assert.rejects(lstat(stateRoot), { code: "ENOENT" }); await chmod(configFile, 0o600);
assert.deepEqual(await loadHostConfig({ path: configFile, expectedSha256: undefined, access: "private-runtime" }), config);
const before = await Promise.all(targets.map(path => readFile(path)));
const paths = productionControlPaths({ DSTACK_STATE_DIR: jobs }, root);
const faux = fauxProvider({ api: "host-fixture", provider: "host-fixture", models: [{ id: "files", input: ["text"] }], tokenSize: { min: 4096, max: 4096 } }), models = createModels(); models.setProvider(faux.provider);
faux.setResponses([...targets.flatMap(path => [
  fauxAssistantMessage(fauxToolCall("read", { path: relative(root, path) }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("write", { path: relative(root, path), content: "replacement" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxToolCall("edit", { path: relative(root, path), oldText: "not a private marker", newText: "replacement" }), { stopReason: "toolUse" }),
]), fauxAssistantMessage("All private control references must remain inaccessible.")]);
const originalOpen = Harness.open; let opens = 0, host: DurableHost | undefined;
Harness.open = async (...args) => { opens += 1; return originalOpen(...args); };
function object(value: unknown): Record<string, unknown> { assert.ok(typeof value === "object" && value !== null && !Array.isArray(value)); return Object.fromEntries(Object.entries(value)); }
function binding() { const db = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true }); try { const row = db.prepare("SELECT value FROM binding WHERE id=1").get(); assert.ok(typeof row?.value === "string"); return object(JSON.parse(row.value)); } finally { db.close(); } }
try {
  host = await DurableHost.open(config, models, { controlPaths: paths, protectedPaths: [configFile] });
  await host.handle(parseOperation({ op: "create", workspaceId: "coding", requestId: "create", cwd: root }));
  await host.handle(parseOperation({ op: "submit", workspaceId: "coding", requestId: "protected", content: "Exercise actual read/write/edit against every control reference." }));
  let completed = false;
  for (const end = performance.now() + 20000; performance.now() < end;) {
    const status = object(await host.handle(parseOperation({ op: "status", workspaceId: "coding", requestId: "protected" })));
    if (status.receipt !== null && object(status.receipt).status === "done") { completed = true; break; } await delay(10);
  }
  assert.equal(completed, true); assert.equal(faux.state.callCount, targets.length * 3 + 1);
  const history: unknown[] = []; let cursor: string | undefined, pages = 0;
  do {
    assert.ok(++pages <= 64);
    const response = await host.client({ token: clientToken(credential), operation: parseClientOperation({ op: "snapshot", workspaceId: "coding", ...(cursor === undefined ? {} : { cursor }) }) });
    assert.ok(response.kind === "reply"); const page = object(response.result); assert.ok(Array.isArray(page.entries)); history.push(...page.entries);
    cursor = typeof page.cursor === "string" ? page.cursor : undefined;
  } while (cursor !== undefined);
  assert.ok(pages >= 2, "Actual authenticated 20-entry paging must cross a real history boundary");
  const snapshot = JSON.stringify(history);
  assert.match(snapshot, /protected host control or authorization state/); assert.equal(snapshot.includes(marker), false); assert.equal(snapshot.includes(credential.secret), false);
  for (const [index, path] of targets.entries()) assert.deepEqual(await readFile(path), before[index]);
  const execution = object(await host.handle(parseOperation({ op: "execution.status", workspaceId: "coding" }))); assert.deepEqual(execution.recentFiles, []); assert.deepEqual(execution.unresolved, []);
  await host.close(); host = undefined;
  assert.equal(binding().version, 4); assert.equal(binding().clientMode, "authenticated"); assert.deepEqual(binding().controlPaths, paths);
  const count = opens;
  let omittedClients: DurableHost | undefined;
  try {
    await assert.rejects(async () => { omittedClients = await DurableHost.open({ ...config, execution: { mode: "durable", maxRecords: 256 } }, models, { controlPaths: paths }); }, /Host root identity differs/, `Production policy must not erase the authenticated/clientless format distinction; preserve ${root}`);
  } finally { await omittedClients?.close(); }
  await assert.rejects(DurableHost.open(config, models), /Host root identity differs/);
  await assert.rejects(DurableHost.open(config, models, { controlPaths: [...paths, join(root, "changed-policy")] }), /Host root identity differs/);
  assert.equal(opens, count);
  const nativeConfig: typeof config = { ...config, stateRoot: join(configRoot, "native-owner"), execution: { mode: "durable", maxRecords: 256 } };
  host = await DurableHost.open(nativeConfig, models, { controlPaths: paths });
  await host.handle(parseOperation({ op: "create", workspaceId: "coding", requestId: "native-create", cwd: root }));
  await host.close(); host = undefined;
  await assert.rejects(DurableHost.open({ ...config, stateRoot: nativeConfig.stateRoot }, models, { controlPaths: paths }), /Host root identity differs/);
  assert.equal(opens, count + 1, "Adding clients must also refuse before Harness activation");
  host = await DurableHost.open(config, models, { controlPaths: [...paths].reverse(), protectedPaths: [configFile] });
  assert.equal(opens, count + 2); assert.equal(faux.state.callCount, targets.length * 3 + 1); await host.close(); host = undefined;
  const old = process.env.DSTACK_CONTROL_OLD_FIXTURE;
  assert.ok(old !== undefined && old.startsWith("/nix/store/"), "Genuine packaged old clients3 fixture is required");
  const bytes = JSON.stringify(config), previous = spawnSync(process.execPath, [old, configFile], { encoding: "utf8", input: "", timeout: 15000, maxBuffer: 128 * 1024, env: { ...process.env, HERDR_DURABLE_HOST_CONFIG_SHA256: createHash("sha256").update(bytes).digest("hex") } });
  await writeFile(join(root, "actual-previous-owner.json"), JSON.stringify({ old, status: previous.status, signal: previous.signal, stdout: previous.stdout, stderr: previous.stderr, error: previous.error?.message }, null, 2), { flag: "wx", mode: 0o600 });
  assert.equal(previous.status, 1); assert.equal(previous.signal, null); assert.equal(previous.error, undefined); assert.equal(previous.stdout, ""); assert.match(previous.stderr, /Host root identity differs/);
  assert.equal(binding().version, 4);
  const result = { proof: "production-control-policy-and-genuine-old-owner-exclusion", root, bindingVersion: 4, actualKernelSpecialConfigBitsRefusedBeforeAllocation: true, actualToolAttempts: targets.length * 3, providerCalls: faux.state.callCount, actualSqlitePrStore: true, wakeAndPolicyAndRotatedRefsProtected: true, privateBytesAbsentFromEntirePagedHistory: true, actualAuthenticatedHistoryPages: pages, deniedMutationsBeforeJournalStart: true, policyOmissionAndRetargetRefusedBeforeHarness: true, clientsOmissionRefusedBeforeHarness: true, clientsAdditionRefusedBeforeHarness: true, canonicalPolicyReopenDidNotInfer: true, genuineClients3OwnerRefused: true, productionModel: false };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600, flush: true }); process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { Harness.open = originalOpen; await host?.close(); }
