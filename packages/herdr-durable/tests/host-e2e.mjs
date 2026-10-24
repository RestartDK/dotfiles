import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile, readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const binary = resolve(process.env.HERDR_TEST_BINARY || ".audit/source/b/target/debug/herdr");
const fixture = resolve(
  process.env.DSTACK_TEST_FIXTURE || "packages/dstack/dist/tests/host-fixture.js",
);
const root = await mkdtemp(join(tmpdir(), "hhp-"));
const cwd = join(root, "worktree");
await mkdir(cwd);
const config = {
  identity: { deploymentId: "herdr-e2e", domain: "work", nodeId: "isolated-node" },
  stateRoot: join(root, "state"),
  model: { provider: "host-fixture", modelId: "files" },
  thinkingLevel: "off",
  authPath: join(root, "auth.json"),
  modelsPath: join(root, "models.json"),
};
const configPath = join(root, "host.json");
await writeFile(configPath, JSON.stringify(config));
const wrapper = join(root, "host");
await writeFile(
  wrapper,
  `#!/bin/sh\nprintf "%s\\n" "$$" > "${root}/child.pid"\nexec '${process.execPath}' '${fixture}' "$@"\n`,
  { mode: 0o700 },
);
const env = {
  ...process.env,
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "xdg-state"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
  HERDR_CONFIG_PATH: join(root, "config.toml"),
  HERDR_SOCKET_PATH: join(root, "api.sock"),
  HERDR_CLIENT_SOCKET_PATH: join(root, "client.sock"),
  HERDR_DURABLE_HOST_CONFIG: configPath,
  HERDR_DURABLE_HOST_EXECUTABLE: wrapper,
  SHELL: "/bin/sh",
};
for (const key of [
  "HERDR_SESSION",
  "HERDR_ENV",
  "HERDR_WORKSPACE_ID",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_SERVER_CONTEXT",
])
  delete env[key];
for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"])
  await mkdir(env[key], { recursive: true, mode: 0o700 });
await writeFile(
  env.HERDR_CONFIG_PATH,
  "onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n",
);
const cli = async (...args) => {
  try {
    const { stdout } = await exec(binary, args, { env, timeout: 8000 });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (error) {
    if (typeof error.stderr === "string" && error.stderr.trim().startsWith("{"))
      return JSON.parse(error.stderr);
    throw error;
  }
};
const call = (operation) => cli("api", "durable", JSON.stringify(operation));
const rawCall = (operation) => new Promise((resolve, reject) => {
  const socket = createConnection(env.HERDR_SOCKET_PATH);
  let buffered = "";
  socket.setTimeout(8000, () => socket.destroy(new Error("API response deadline exceeded")));
  socket.once("error", reject);
  socket.once("connect", () => socket.write(`${JSON.stringify({
    id: "host-regression",
    method: "durable.host.v1",
    params: operation,
  })}\n`));
  socket.on("data", (data) => {
    buffered += data;
    const newline = buffered.indexOf("\n");
    if (newline === -1) return;
    socket.end();
    try { resolve(JSON.parse(buffered.slice(0, newline))); }
    catch (error) { reject(error); }
  });
  socket.once("end", () => {
    if (!buffered.includes("\n")) reject(new Error("API closed before its response"));
  });
});
let server;
let exited;
let logs = "";
async function waitHealth(until) {
  for (let i = 0; i < 400; i++) {
    const health = await call({ op: "health" });
    if (health.result?.value && until(health.result.value)) return health.result.value;
    await delay(25);
  }
  throw new Error("Health deadline exceeded");
}
async function start(until = (value) => value.status.phase === "ready") {
  server = spawn(binary, ["server"], { env, stdio: ["ignore", "pipe", "pipe"] });
  exited = new Promise((resolve, reject) => {
    server.once("close", resolve);
    server.once("error", reject);
  });
  server.stdout.on("data", (data) => {
    logs += data;
  });
  server.stderr.on("data", (data) => {
    logs += data;
  });
  for (let i = 0; i < 200; i++) {
    try {
      const health = await call({ op: "health" });
      if (health.result?.value && until(health.result.value)) {
        assert.equal(
          await readlink(`/proc/${server.pid}/ns/net`),
          await readlink("/proc/self/ns/net"),
        );
        return health.result.value;
      }
    } catch (error) {
      if (server.exitCode !== null) throw error;
    }
    await delay(25);
  }
  throw new Error(`Host not ready\n${logs}`);
}
async function stop() {
  if (server?.exitCode === null) {
    await cli("server", "stop");
    const timer = setTimeout(() => server.kill("SIGKILL"), 15000);
    try {
      assert.equal(await exited, 0, logs);
    } finally {
      clearTimeout(timer);
    }
    const childPid = Number(await readFile(join(root, "child.pid"), "utf8").catch(() => "0"));
    if (childPid) assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  }
}
async function requestBoundaryAndConfigPinning() {
  env.HERDR_DURABLE_HOST_CONFIG = configPath;
  env.HERDR_DURABLE_HOST_EXECUTABLE = wrapper;
  await writeFile(
    wrapper,
    `#!/bin/sh\nprintf "%s\\n" "$$" > "${root}/child.pid"\nexec '${process.execPath}' '${fixture}' "$@"\n`,
    { mode: 0o700 },
  );
  const failures = [];
  const observations = {};
  const indexCounts = () => {
    const db = new DatabaseSync(join(config.stateRoot, "host.sqlite"), { readOnly: true });
    try {
      return db.prepare(`SELECT
        (SELECT COUNT(*) FROM workspaces) AS workspaces,
        (SELECT COUNT(*) FROM admissions) AS admissions`).get();
    } finally {
      db.close();
    }
  };
  try {
    let health = await start();
    const boot = health.status.ready.bootId;
    const codes = [];
    const invalid = [
      { send: rawCall, operation: { op: "submit", workspaceId: "durable-workspace", requestId: "oversized", content: "x".repeat(300 * 1024) } },
      { send: call, operation: { op: "snapshot", workspaceId: "" } },
      { send: call, operation: { op: "status", workspaceId: "durable-workspace", requestId: "" } },
      { send: call, operation: { op: "submit", workspaceId: "durable-workspace", requestId: "bad", content: "" } },
      { send: call, operation: { op: "create", workspaceId: "bad", requestId: "bad-cwd", cwd: "relative" } },
    ];
    for (const { send, operation } of invalid) {
      const previous = health.status.ready.bootId;
      const response = await send(operation);
      codes.push(response.error?.code);
      health = response.error?.code === "durable_host_ack_lost"
        ? await waitHealth((value) =>
          (value.status.phase === "ready" && value.status.ready.bootId !== previous) ||
          (value.status.phase === "unavailable" && value.status.attempts === 3))
        : (await call({ op: "health" })).result.value;
      if (health.status.phase !== "ready") break;
    }
    observations.arguments = { boot, codes, health };
    assert.deepEqual(codes, invalid.map(() => "invalid_request"));
    assert.equal(health.status.ready.bootId, boot);
    assert.ok((await call({ op: "discover" })).result);
  } catch (error) {
    failures.push({ case: "invalid-arguments", error: String(error) });
  } finally {
    await stop();
  }
  const target = join(root, "retargeted-state");
  try {
    const ready = await start();
    const childPid = Number(await readFile(join(root, "child.pid"), "utf8"));
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    const command = await readFile(`/proc/${childPid}/cmdline`, "utf8");
    assert.ok(command.split("\0").includes(fixture));
    assert.ok(command.split("\0").includes(configPath));
    await writeFile(configPath, JSON.stringify({ ...config, stateRoot: target }));
    process.kill(childPid, "SIGKILL");
    const recovered = await waitHealth((value) =>
      (value.status.phase === "ready" && value.status.ready.bootId !== ready.status.ready.bootId) ||
      (value.status.phase === "unavailable" && value.status.attempts === 3));
    const absent = await access(target).then(() => false, (error) => {
      if (error.code === "ENOENT") return true;
      throw error;
    });
    observations.configuration = { before: ready, after: recovered, target, absent };
    assert.equal(absent, true, "Changed configuration must be rejected before touching its store");
    assert.equal(recovered.status.phase, "unavailable");
  } catch (error) {
    failures.push({ case: "configuration-pinning", error: String(error) });
  } finally {
    await stop();
    await writeFile(configPath, JSON.stringify(config));
  }
  try {
    await start();
    const original = await call({ op: "snapshot", workspaceId: "durable-workspace" });
    const before = indexCounts();
    const denied = await call({ op: "create", workspaceId: " \t\n\u00a0", requestId: "blank-workspace", cwd });
    const after = indexCounts();
    observations.workspaceIdentity = { denied, before, after };
    await stop();
    await start();
    const resumed = await call({ op: "snapshot", workspaceId: "durable-workspace" });
    observations.workspaceIdentity.resumed = resumed;
    assert.equal(denied.error?.code, "invalid_request");
    assert.deepEqual(after, before, "Invalid identity must not mutate either admission table");
    assert.deepEqual(resumed.result.value.workspace, original.result.value.workspace);
    assert.equal((await call({ op: "status", workspaceId: "durable-workspace", requestId: "input-one" })).result.value.receipt.status, "done");
  } catch (error) {
    failures.push({ case: "workspace-identity", error: String(error) });
  } finally {
    await stop();
  }
  await writeFile(join(root, "review-regressions.json"), JSON.stringify({ observations, failures }, null, 2));
  assert.deepEqual(failures, [], JSON.stringify(observations));
  console.log(JSON.stringify({ event: "pass", proof: "request-boundary-config-pinning", root }));
}

console.log(
  JSON.stringify({
    event: "fixture",
    root,
    binary,
    node: process.execPath,
    model: "host-fixture/files (offline)",
  }),
);
try {
  const ready = await start();
  assert.deepEqual(ready.status.ready.identity, config.identity);
  assert.deepEqual(ready.operations, ["create", "discover", "snapshot", "submit", "status"]);
  const workspace = await cli(
    "workspace",
    "create",
    "--cwd",
    cwd,
    "--label",
    "isolated-host-proof",
    "--no-focus",
  );
  const paneId = workspace.result.root_pane.pane_id;
  const before = await cli("pane", "process-info", "--pane", paneId);
  const handoff = await cli("server", "live-handoff");
  assert.equal(handoff.error.code, "handoff_failed");
  assert.match(handoff.error.message, /durable host/);
  const after = await cli("pane", "process-info", "--pane", paneId);
  assert.equal(after.result.process_info.shell_pid, before.result.process_info.shell_pid);
  const created = await call({
    op: "create",
    requestId: "create",
    workspaceId: "durable-workspace",
    cwd,
  });
  assert.ok(created.result, JSON.stringify(created));
  const submit = {
    op: "submit",
    workspaceId: "durable-workspace",
    requestId: "input-one",
    content: "Write the proof file",
  };
  const admitted = await call(submit);
  assert.ok(admitted.result, JSON.stringify(admitted));
  let receipt;
  for (let i = 0; i < 200; i++) {
    const status = await call({
      op: "status",
      workspaceId: "durable-workspace",
      requestId: "input-one",
    });
    receipt = status.result.value.receipt;
    if (receipt?.status === "done") break;
    await delay(25);
  }
  assert.equal(receipt.status, "done");
  assert.equal(await readFile(join(cwd, "proof.txt"), "utf8"), "host-owned\n");
  assert.equal((await call({ ...submit, content: "different" })).error.code, "request_conflict");
  await stop();
  const restarted = await start();
  assert.notEqual(restarted.status.ready.bootId, ready.status.ready.bootId);
  assert.deepEqual((await call(submit)).result.value.receipt, receipt);
  const snapshot = await call({ op: "snapshot", workspaceId: "durable-workspace" });
  assert.equal(snapshot.result.value.entries.filter((entry) => entry.kind === "pi.user").length, 1);
  await stop();
  console.log(
    JSON.stringify({
      event: "pass",
      proof: "herdr-node-cli",
      root,
      receipt,
      boot: restarted.status.ready.bootId,
    }),
  );
  env.HERDR_DURABLE_HOST_EXECUTABLE = join(root, "missing");
  const missing = await start(
    (value) => value.status.phase === "unavailable" && value.status.attempts === 3,
  );
  assert.deepEqual(missing.operations, []);
  assert.equal((await call(submit)).error.code, "durable_host_unavailable");
  assert.ok((await cli("workspace", "list")).result);
  assert.equal((await cli("server", "live-handoff")).error.code, "handoff_failed");
  await stop();
  env.HERDR_DURABLE_HOST_EXECUTABLE = wrapper;
  const adversary = join(root, "adversary.mjs");
  const effects = join(root, "sent-requests.jsonl");
  await writeFile(
    adversary,
    `
import { readFileSync, appendFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(JSON.stringify({ v:1, type:"ready", identity:config.identity,
  bootId:String(process.pid), maxFrameBytes:262144, maxInFlight:1, tools:["read","write","edit"] }) + "\\n");
process.stdin.once("data", (data) => {
  appendFileSync(${JSON.stringify(effects)}, data);
  setTimeout(() => process.exit(7), 1500);
});
`,
  );
  await writeFile(
    wrapper,
    `#!/bin/sh\nprintf "%s\\n" "$$" > "${root}/child.pid"\nexec '${process.execPath}' '${adversary}' "$@"\n`,
    { mode: 0o700 },
  );
  const adverseReady = await start();
  const burst = await Promise.all(
    Array.from({ length: 24 }, (_, index) => call({ ...submit, requestId: `burst-${index}` })),
  );
  assert.ok(burst.some((response) => response.error?.code === "durable_host_busy"));
  assert.ok(burst.some((response) => response.error?.code === "durable_host_ack_lost"));
  assert.ok(burst.every((response) => response.error));
  await waitHealth(
    (value) =>
      value.status.phase === "ready" &&
      value.status.ready.bootId !== adverseReady.status.ready.bootId,
  );
  assert.equal((await readFile(effects, "utf8")).trim().split("\n").length, 1);
  await stop();
  console.log(
    JSON.stringify({ event: "pass", proof: "guardian-backpressure-no-blind-retry", root }),
  );
  delete env.HERDR_DURABLE_HOST_CONFIG;
  assert.equal(
    (await start((value) => value.status.phase === "disabled")).status.phase,
    "disabled",
  );
  await stop();
  console.log(JSON.stringify({ event: "pass", proof: "optional-host-unavailable-disabled", root }));
  await requestBoundaryAndConfigPinning();
} finally {
  await stop();
  await writeFile(join(root, "server.log"), logs);
}
