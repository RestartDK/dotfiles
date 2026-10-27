import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

process.umask(0o077);
const exec = promisify(execFile);
const binary = process.env.HERDR_TEST_BINARY, pkg = process.env.DSTACK_TEST_PACKAGE;
const python = process.env.DSTACK_TEST_PYTHON;
for (const [name, path] of Object.entries({ binary, pkg, python, helper: process.env.DSTACK_COMMAND_HELPER, systemctl: process.env.DSTACK_SYSTEMCTL }))
  assert.ok(path?.startsWith("/nix/store/"), `Explicit packaged reference required: ${name}`);
assert.ok(process.env.XDG_RUNTIME_DIR, "Keep the original user-manager runtime");
const bus = process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
const root = await mkdtemp(join(tmpdir(), "herdr-clients-")), running = [], intents = new Set();
let providerRequests = 0;
const provider = createServer((request, response) => { providerRequests++; request.resume(); response.writeHead(500, { "content-type": "application/json" }); response.end('{"error":{"message":"No inference belongs in this proof"}}'); });
await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
const providerPort = provider.address().port;
async function until(check, name, ms = 20000) {
  for (const end = performance.now() + ms; performance.now() < end;) { const value = await check(); if (value !== undefined) return value; await delay(25); }
  throw new Error(`${name} deadline exceeded; preserve ${root}`);
}
async function bounded(promise, name, ms = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} deadline exceeded; preserve ${root}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function prepare(domain) {
  const path = join(root, domain), privateConfig = join(root, ".config/herdr-durable", domain), privateState = join(root, ".local/state/herdr-durable", domain);
  for (const directory of [path, privateConfig, privateState]) await mkdir(directory, { recursive: true, mode: 0o700 });
  const identity = { deploymentId: "herdr-clients-proof", domain, nodeId: "same-node-name" }, credentials = {};
  for (const principal of ["operator", "reader", "other"]) {
    const file = join(privateConfig, `${principal}.key`);
    await exec(join(pkg, "bin/dstack-client"), ["key", "--deployment", identity.deploymentId, "--domain", domain, "--node", identity.nodeId, "--principal", principal, "--out", file]);
    credentials[principal] = file;
  }
  const portReservation = createServer(); await new Promise(resolve => portReservation.listen(0, "127.0.0.1", resolve));
  const port = portReservation.address().port; await new Promise(resolve => portReservation.close(resolve));
  for (const directory of ["coding", "other", "cache"]) await mkdir(join(path, directory), { mode: 0o700 });
  const configPath = join(privateConfig, "host.json"), authPath = join(privateConfig, "auth.json"), modelsPath = join(privateConfig, "models.json");
  await writeFile(authPath, "{}", { flag: "wx", mode: 0o600 });
  await writeFile(modelsPath, JSON.stringify({ providers: { "no-inference": { baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: "openai-completions", apiKey: "task-local-dummy-not-a-production-credential", models: [{ id: "local", contextWindow: 16384, maxTokens: 1024 }] } } }), { flag: "wx", mode: 0o600 });
  const config = {
    identity, stateRoot: join(privateState, "owner"), model: { provider: "no-inference", modelId: "local" }, thinkingLevel: "off", authPath, modelsPath,
    execution: { mode: "durable", maxRecords: 256, clients: { version: 1, listen: { host: "127.0.0.1", port },
      workspaces: ["coding", "other"].map(workspaceId => ({ workspaceId, cwd: join(path, workspaceId) })),
      grants: [
        { principalId: "operator", tokenFile: credentials.operator, workspaces: [{ workspaceId: "coding", permissions: ["read", "submit", "abort", "command.cancel"] }] },
        { principalId: "reader", tokenFile: credentials.reader, workspaces: [{ workspaceId: "coding", permissions: ["read"] }] },
        { principalId: "other", tokenFile: credentials.other, workspaces: [{ workspaceId: "other", permissions: ["read", "submit", "abort", "command.cancel"] }] },
      ],
    } },
  };
  await writeFile(configPath, JSON.stringify(config), { flag: "wx", mode: 0o600, flush: true });
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: privateConfig, XDG_STATE_HOME: privateState, XDG_CACHE_HOME: join(path, "cache"), DSTACK_HOST_MODE: "deployment", DSTACK_STATE_DIR: join(root, ".local/state/dstack"),
    DBUS_SESSION_BUS_ADDRESS: bus, HERDR_CONFIG_PATH: join(path, "config.toml"), HERDR_SOCKET_PATH: join(path, "api.sock"), HERDR_CLIENT_SOCKET_PATH: join(path, "client.sock"), HERDR_DURABLE_HOST_CONFIG: configPath, SHELL: "/bin/sh" };
  for (const key of ["HERDR_SESSION", "HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_SERVER_CONTEXT", "HERDR_DURABLE_HOST_EXECUTABLE", "HERDR_DURABLE_HOST_CONFIG_SHA256"]) delete env[key];
  await writeFile(env.HERDR_CONFIG_PATH, "onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n", { flag: "wx", mode: 0o600 });
  return { path, config, credentials, env, endpoint: `http://127.0.0.1:${port}` };
}
function launch(prepared) {
  const child = spawn(binary, ["server"], { env: prepared.env, stdio: ["ignore", "pipe", "pipe"] });
  const owner = { ...prepared, child, logs: "", exit: new Promise((resolve, reject) => { child.once("close", (code, signal) => resolve({ code, signal })); child.once("error", reject); }) };
  running.push(owner);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { owner.logs = (owner.logs + bytes.toString()).slice(-32768); });
  return owner;
}
async function native(owner, operation) {
  let result;
  try { result = await exec(binary, ["api", "durable", JSON.stringify(operation)], { env: owner.env, timeout: 65000, maxBuffer: 1024 * 1024 }); }
  catch (error) { if (typeof error.stderr === "string" && error.stderr.trim().startsWith("{")) return JSON.parse(error.stderr); throw error; }
  return JSON.parse(result.stdout);
}
async function value(owner, operation) {
  const response = await native(owner, operation); assert.ok(response.result, JSON.stringify(response)); return response.result.value;
}
async function ready(owner) {
  const health = await until(async () => {
    assert.equal(owner.child.exitCode, null, owner.logs);
    try { const response = await native(owner, { op: "health" }); return response.result?.value?.status.phase === "ready" ? response.result.value : undefined; }
    catch (error) { if (owner.child.exitCode !== null) throw error; return undefined; }
  }, "Actual Rust-managed production Node readiness");
  assert.deepEqual(health.status.ready.tools, ["read", "write", "edit"]);
  assert.equal(await readlink(`/proc/${owner.child.pid}/ns/net`), await readlink("/proc/self/ns/net"));
  return health;
}
async function client(owner, principal, command, workspaceId = "coding", extra = [], credential = owner.credentials[principal]) {
  const args = [command, "--endpoint", owner.endpoint, "--credential", credential, ...(command === "discover" ? [] : ["--workspace", workspaceId]), ...extra];
  try { const output = await exec(join(pkg, "bin/dstack-client"), args, { env: owner.env, timeout: 65000, maxBuffer: 1024 * 1024 }); return { code: 0, result: JSON.parse(output.stdout) }; }
  catch (error) { if (error.code !== 1) throw error; assert.equal(error.stdout, ""); return { code: 1, error: error.stderr.trim() }; }
}
async function reply(...args) { const result = await client(...args); assert.equal(result.code, 0, result.error); return result.result; }
async function deny(...args) { const result = await client(...args); assert.equal(result.code, 1); assert.ok(result.error.length > 0); return result.error; }
async function authorize(owner, workspaceId, intentId) {
  const marker = join(owner.path, workspaceId, `${intentId}.txt`);
  const result = await value(owner, { op: "command.authorize", workspaceId, intentId, spec: { argv: [process.execPath, "-e", "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],'ready\\n',{flag:'wx',mode:384});setInterval(()=>{},1000)", marker], timeoutSeconds: 90 } });
  const intent = { owner, workspaceId, intentId, marker, spec: JSON.parse(result.authorization.specJson) }; intents.add(intent); return intent;
}
const command = (intent, op) => value(intent.owner, { op: `command.${op}`, workspaceId: intent.workspaceId, intentId: intent.intentId });
async function settle(intent) {
  const current = await command(intent, "status");
  if (current.command.phase.kind === "authorized") { await command(intent, "cancel"); intents.delete(intent); return; }
  if (current.command.phase.kind !== "adopted") {
    const initial = await command(intent, "inspect");
    if (!(initial.outcome.kind === "recorded" && initial.containment.kind === "empty") && current.command.cancellation !== "requested") await command(intent, "cancel");
    const observation = await until(async () => { const view = await command(intent, "inspect"); return view.outcome.kind === "recorded" && view.containment.kind === "empty" ? view : undefined; }, "Original receipt and empty containment");
    assert.equal(observation.outcome.receipt.outcome.cause, "cancelled");
    assert.equal((await command(intent, "adopt")).phase.kind, "adopted");
  }
  assert.deepEqual(await command(intent, "release"), { released: true });
  const custody = await exec(process.env.DSTACK_SYSTEMCTL, ["--user", "show", intent.spec.unit, "--property=NFileDescriptorStore", "--value"], { env: intent.owner.env, timeout: 5000 });
  assert.equal(custody.stdout.trim(), "0"); intents.delete(intent);
}
function records(owner) {
  const db = new DatabaseSync(join(owner.config.stateRoot, "host.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT record_json FROM herdr_execution_records ORDER BY root_id, sequence").all().map(row => JSON.parse(row.record_json).event); }
  finally { db.close(); }
}
async function detachActualCli(owner) {
  const code = `import json,os,signal,subprocess,sys\np=subprocess.Popen(sys.argv[1:],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)\nfd=os.pidfd_open(p.pid)\ntry:\n line=p.stdout.readline(8388609)\n if len(line)>8388608 or not line.endswith(b'\\n'): raise RuntimeError('No bounded actual CLI baseline')\n print(json.dumps({'baseline':json.loads(line),'originalPidfd':True}),flush=True)\n if sys.stdin.readline().strip()!='detach': raise RuntimeError('Missing explicit detach')\n signal.pidfd_send_signal(fd,signal.SIGINT)\n out,err=p.communicate(timeout=12)\n print(json.dumps({'code':p.returncode,'stderr':err.decode(),'originalExited':True}),flush=True)\nfinally:\n if p.poll() is None:\n  signal.pidfd_send_signal(fd,signal.SIGKILL)\n  p.communicate(timeout=12)\n os.close(fd)\n`;
  const child = spawn(python, ["-c", code, join(pkg, "bin/dstack-client"), "watch", "--endpoint", owner.endpoint, "--credential", owner.credentials.operator, "--workspace", "coding"], { env: owner.env, stdio: ["pipe", "pipe", "pipe"] });
  const exit = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator](); let errors = ""; child.stderr.on("data", bytes => { errors = (errors + bytes).slice(-32768); });
  try {
    const start = JSON.parse((await bounded(lines.next(), "CLI atomic baseline")).value); assert.equal(start.originalPidfd, true); assert.equal(start.baseline.type, "snapshot"); assert.ok(!("seq" in start.baseline));
    child.stdin.end("detach\n");
    const end = JSON.parse((await bounded(lines.next(), "Original CLI detach join")).value); assert.equal(end.code, 1); assert.equal(end.originalExited, true); assert.match(end.stderr, /No cancellation was sent/);
    assert.equal(await bounded(exit, "Original CLI custodian join"), 0, errors);
  } finally { child.stdin.end(); await bounded(exit, "CLI custodian retirement", 26000); await lines.return?.(); }
}
async function entrypointCompatibility(prepared) {
  const env = { ...prepared.env }; delete env.DSTACK_HOST_MODE;
  async function stopOriginal(owner, label) {
    await exec(binary, ["server", "stop"], { env: owner.env, timeout: 15000 });
    assert.deepEqual(await bounded(owner.exit, "Compatibility original Rust owner join"), { code: 0, signal: null }, owner.logs);
    const index = running.indexOf(owner); assert.ok(index >= 0); running.splice(index, 1);
    await writeFile(join(root, `entry-${label}.log`), owner.logs, { flag: "wx", mode: 0o600 });
  }
  function binding(config) {
    const db = new DatabaseSync(join(config.stateRoot, "host.sqlite"), { readOnly: true });
    try { const row = db.prepare("SELECT value FROM binding WHERE id=1").get(); assert.equal(typeof row.value, "string"); return JSON.parse(row.value); }
    finally { db.close(); }
  }
  const nativeConfig = { ...prepared.config, stateRoot: join(dirname(prepared.config.stateRoot), "native-entry-owner"), execution: { mode: "durable", maxRecords: 256 } };
  await writeFile(env.HERDR_DURABLE_HOST_CONFIG, JSON.stringify(nativeConfig), { mode: 0o600, flush: true });
  const nativeOwner = launch({ ...prepared, config: nativeConfig, env }); await ready(nativeOwner); assert.equal(binding(nativeConfig).version, 4); assert.equal(binding(nativeConfig).clientMode, "native");
  await stopOriginal(nativeOwner, "native-durable");
  const legacy = { ...prepared.config, stateRoot: join(dirname(prepared.config.stateRoot), "legacy-entry-owner"), execution: undefined };
  await writeFile(env.HERDR_DURABLE_HOST_CONFIG, JSON.stringify(legacy), { mode: 0o600, flush: true });
  const boots = [];
  for (const label of ["legacy-first", "legacy-reopen"]) {
    const owner = launch({ ...prepared, config: legacy, env }); const health = await ready(owner); boots.push(health.status.ready.bootId);
    await value(owner, { op: "create", workspaceId: "legacy-coding", requestId: "legacy-create", cwd: join(prepared.path, "coding") });
    assert.equal(binding(legacy).version, 1);
    const db = new DatabaseSync(join(legacy.stateRoot, "host.sqlite"), { readOnly: true });
    try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM workspaces").get().count, 1); } finally { db.close(); }
    await stopOriginal(owner, label);
  }
  assert.notEqual(boots[0], boots[1]);
  await writeFile(env.HERDR_DURABLE_HOST_CONFIG, JSON.stringify(prepared.config), { mode: 0o600, flush: true });
  return { nonDeploymentDurableBinding4: true, productionLegacy1Reopened: true, compatibilityOriginalOwnersJoined: 3 };
}
const failures = [];
let result;
try {
  const preparedWork = await prepare("work"); const compatibility = await entrypointCompatibility(preparedWork);
  const work = launch(preparedWork), personal = launch(await prepare("personal"));
  const [workReady, personalReady] = await Promise.all([ready(work), ready(personal)]);
  assert.notEqual(workReady.status.ready.bootId, personalReady.status.ready.bootId);
  for (const owner of [work, personal]) {
    assert.deepEqual((await reply(owner, "operator", "discover")).identity, owner.config.identity);
    await reply(owner, "operator", "open"); await reply(owner, "other", "open", "other");
  }
  const a = await stat(join(work.config.stateRoot, "host.sqlite")), b = await stat(join(personal.config.stateRoot, "host.sqlite")); assert.notEqual(`${a.dev}:${a.ino}`, `${b.dev}:${b.ino}`);
  const active = await authorize(work, "coding", "active"), other = await authorize(work, "other", "other-only"), foreign = await authorize(personal, "coding", "personal-only");
  const sdk = await command(active, "start"); assert.equal(typeof sdk.taskKey, "string"); assert.equal(typeof sdk.conversationKey, "string");
  await until(async () => { try { return await readFile(active.marker, "utf8"); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } }, "Actual independent payload start");
  const initial = await command(active, "inspect"); assert.equal(initial.outcome.kind, "unobserved"); assert.equal(initial.containment.kind, "active");
  const beforeWork = records(work), beforePersonal = records(personal), before = await command(active, "status");
  assert.match(await deny(personal, "operator", "discover", "coding", [], work.credentials.operator), /authentication failed/i);
  assert.match(await deny(work, "operator", "discover", "coding", [], personal.credentials.operator), /authentication failed/i);
  for (const [principal, workspaceId, commandName, extra] of [
    ["reader", "coding", "abort", []], ["reader", "coding", "open", []], ["reader", "coding", "command.cancel", ["--intent", "active"]],
    ["other", "coding", "command.cancel", ["--intent", "active"]], ["operator", "other", "command.cancel", ["--intent", "other-only"]],
    ["operator", "guessed", "execution.status", []],
  ]) assert.match(await deny(work, principal, commandName, workspaceId, extra), /scope does not permit/i);
  await deny(work, "operator", "command.cancel", "coding", ["--intent", "other-only"]);
  await deny(work, "operator", "command.cancel", "coding", ["--intent", "personal-only"]);
  assert.deepEqual(records(work), beforeWork); assert.deepEqual(records(personal), beforePersonal);
  assert.deepEqual(await command(active, "status"), before);
  const sdkAbort = await reply(work, "operator", "abort"); assert.equal(sdkAbort.ordinarySdkWorkStopped, true);
  assert.deepEqual(await command(active, "status"), before); assert.deepEqual(records(work), beforeWork);
  await detachActualCli(work);
  assert.deepEqual(await command(active, "status"), before); assert.deepEqual(records(work), beforeWork);
  assert.equal((await command(active, "inspect")).containment.kind, "active", "SDK abort and CLI SIGINT must leave the independent business command active");
  const reader = await reply(work, "reader", "execution.status"); assert.deepEqual(reader.recentCommands, [{ intentId: "active", phase: "activated" }]);
  const cancelled = await reply(work, "operator", "command.cancel", "coding", ["--intent", "active"]); assert.equal(cancelled.cancellation, "requested");
  const observed = await until(async () => { const view = await command(active, "inspect"); return view.outcome.kind === "recorded" && view.containment.kind === "empty" ? view : undefined; }, "Authenticated business cancellation receipt");
  assert.equal(observed.outcome.receipt.outcome.kind, "signal"); assert.equal(observed.outcome.receipt.outcome.cause, "cancelled");
  await settle(active); await settle(other); await settle(foreign);
  const events = records(work).filter(event => event.intentId === "active" || (event.kind === "command.authorized" && JSON.parse(event.specJson).intentId === "active"));
  assert.deepEqual(events.map(event => event.kind), ["command.authorized", "command.attempted", "command.activated", "command.cancel-requested", "command.adopted"]);
  assert.deepEqual(events.find(event => event.kind === "command.attempted").sdk, { kind: "task", taskKey: sdk.taskKey, conversationKey: sdk.conversationKey });
  assert.deepEqual((await reply(work, "reader", "execution.status")).unresolved, []);
  for (const [owner, health] of [[work, workReady], [personal, personalReady]]) assert.equal((await value(owner, { op: "health" })).status.ready.bootId, health.status.ready.bootId);
  assert.equal(providerRequests, 0);
  result = { proof: "rust-managed-authenticated-active-business-controls", root, sdk, providerRequests, ...compatibility, packagedDefaultBackend: true, productionHostEntrypoint: true, privateDeploymentMode: true, sharedHomeIndependentNamespaces: true, simultaneousDomains: true, independentSqlite: true, completeAudienceIsolation: true, principalWorkspaceAndGuessedIntentIsolation: true, deniedControlsPreservedJournals: true, sdkAbortAndOriginalPidfdCliSigintKeptBusinessActive: true, authenticatedBusinessCancelRecorded: true, originalReceiptAndEmptyContainment: true, oneActualSdkAttempt: true, originalCustodyReleased: true, modelTools: ["read", "write", "edit"], productionModel: false };
} catch (error) { failures.push(error); }
let custodyJoined = true;
for (const intent of intents) try { await settle(intent); } catch (error) { custodyJoined = false; failures.push(error); }
if (!custodyJoined) {
  await writeFile(join(root, "custody-uncertain.json"), JSON.stringify({ preserve: root, failures: failures.map(String) }, null, 2), { flag: "wx", mode: 0o600 });
  process.stderr.write(`Original custody retained after uncertain cleanup; preserve ${root}\n`);
  await new Promise(() => undefined);
}
for (const owner of running) {
  try {
    if (owner.child.exitCode === null) await exec(binary, ["server", "stop"], { env: owner.env, timeout: 15000 });
    assert.deepEqual(await bounded(owner.exit, "Original Rust owner normal stop"), { code: 0, signal: null }, owner.logs);
  } catch (error) { failures.push(error); }
}
await new Promise(resolve => provider.close(resolve));
for (const owner of running) await writeFile(join(owner.path, "server.log"), owner.logs, { flag: "wx", mode: 0o600 });
if (failures.length) throw new AggregateError(failures, `Managed client proof or original-custody cleanup failed; preserve ${root}`);
await writeFile(join(root, "result.json"), JSON.stringify({ ...result, originalOwnersJoined: true }, null, 2), { flag: "wx", mode: 0o600, flush: true });
process.stdout.write(`${JSON.stringify({ ...result, originalOwnersJoined: true })}\n`);
