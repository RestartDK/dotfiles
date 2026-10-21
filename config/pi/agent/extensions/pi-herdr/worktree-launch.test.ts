import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  LaunchAttempt,
  managedShellEnvironment,
  processBirth,
  shellQuote,
  type LaunchOptions,
} from "./launch-attempt.ts";
import { HandoffReadiness } from "./worktree-state.ts";

const root = resolve(import.meta.dirname, "../../../../..");

test("new panes retain profile identity without source project exports", () => {
  assert.deepEqual(
    managedShellEnvironment({
      SHELL: "/bin/zsh",
      ZDOTDIR: "/profile/zsh",
      PI_CODING_AGENT_DIR: "/profile/pi",
      PI_CODING_AGENT_SESSION_DIR: "/profile/sessions",
      PATH: "/source/project/bin",
      DIRENV_DIFF: "source-project-state",
      TOKEN: "secret",
    }),
    {
      REPO_ENV_MANAGED: "1",
      SHELL: "/bin/zsh",
      ZDOTDIR: "/profile/zsh",
      PI_CODING_AGENT_DIR: "/profile/pi",
      PI_CODING_AGENT_SESSION_DIR: "/profile/sessions",
    },
  );
});

async function fixture(t: TestContext, hook = "", overrides: Partial<LaunchOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "launch-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const claimPath = join(directory, "claim");
  await mkdir(claimPath);
  await writeFile(
    join(claimPath, "owner"),
    JSON.stringify({ id: "attempt", sourceSessionFile: "fixture" }),
  );
  const launch = new LaunchAttempt(join(directory, "launch"), {
    id: "attempt",
    cwd: directory,
    namespace: null,
    claimPath,
    environmentMs: 2_000,
    startupMs: 1_000,
    leaseMs: 500,
    ...overrides,
  });
  await launch.prepare();
  await writeFile(join(directory, ".bashrc"), `repo_env_prepare() { ${hook || ":"}; }\n`);
  return {
    directory,
    launch,
    readiness: new HandoffReadiness(claimPath, "attempt"),
    start(payload = "touch payload; exec sleep 30") {
      const child = spawn("sh", ["-c", launch.command(["sh", "-c", payload])], {
        cwd: directory,
        env: {
          ...process.env,
          REPO_LAUNCH_DIRECTORY: undefined,
          HOME: directory,
          SHELL: "bash",
          PATH: `${root}/bin:${process.env.PATH}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (value: Buffer) => {
        stderr += value.toString();
      });
      child.stdout.resume();
      const exited = once(child, "close");
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          await launch.stop("cancelled");
          await exited;
        }
      });
      return { child, exited, stderr: () => stderr };
    },
  };
}

async function phase(launch: LaunchAttempt, expected: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    await launch.pulse();
    const state = await launch.read();
    if (state.phase === expected) return state;
    assert.equal(state.kind, "active", JSON.stringify(state));
    await delay(10);
  }
  throw new Error(`Never reached ${expected}`);
}

test("preparation exports survive into the payload without entering the diagnostic receipt", async (t) => {
  const f = await fixture(t, "export PRIVATE_FIXTURE=secret-fixture", { claimPath: null });
  const process = f.start('test "$PRIVATE_FIXTURE" = secret-fixture && printf ready > payload');
  await f.launch.waitForStartup();
  assert.deepEqual(await process.exited, [0, null], process.stderr());
  assert.equal(await readFile(join(f.directory, "payload"), "utf8"), "ready");
  assert.doesNotMatch(await readFile(f.launch.logPath, "utf8"), /secret-fixture/);
});

for (const failure of ["return 37", "exit 17"]) {
  test(`failed preparation (${failure}) records its phase and never runs the payload`, async (t) => {
    const f = await fixture(t, failure);
    const process = f.start();
    await process.exited;
    const state = await f.launch.read();
    assert.equal(state.kind, "exited");
    assert.equal(state.phase, "environment");
    if (state.kind === "exited") assert.equal(state.code, failure.endsWith("37") ? 37 : 17);
    await assert.rejects(readFile(join(f.directory, "payload")), { code: "ENOENT" });
  });
}

for (const reason of ["cancelled", "timedout", "sourceLost"] as const) {
  test(`${reason} stops owned slow preparation and rejects late readiness`, async (t) => {
    const f = await fixture(t, "sleep 30; export READY=1", {
      environmentMs: reason === "timedout" ? 250 : 2_000,
      leaseMs: reason === "sourceLost" ? 150 : 2_000,
    });
    const process = f.start();
    await phase(f.launch, "environment");
    if (reason === "cancelled") await f.launch.stop(reason);
    await process.exited;
    const state = await f.launch.read();
    assert.equal(state.kind, "exited", JSON.stringify(state));
    if (state.kind === "exited") assert.equal(state.reason, reason);
    assert.equal(await f.readiness.read(), "stopped");
    await assert.rejects(f.readiness.decide("ready", f.launch), /not accepting|stopping/);
    await assert.rejects(readFile(join(f.directory, "payload")), { code: "ENOENT" });
  });
}

test("environment and startup have separate budgets; ready arbitration wins over later cancellation", async (t) => {
  const f = await fixture(t, "sleep 0.3", { environmentMs: 800, startupMs: 150, leaseMs: 2_000 });
  const process = f.start("sleep 0.4; touch payload");
  await phase(f.launch, "startup");
  assert.equal(await f.readiness.decide("ready", f.launch), "ready");
  const state = await f.launch.stop("cancelled");
  assert.equal(state.kind, "transferred");
  assert.deepEqual(await process.exited, [0, null], process.stderr());
  await readFile(join(f.directory, "payload"));
});

test("cancellation during authorization validation cannot grant a generic payload", async (t) => {
  const f = await fixture(t, ":", { claimPath: null });
  const abort = new AbortController();
  const accepting = f.launch.assertAccepting.bind(f.launch);
  t.mock.method(f.launch, "assertAccepting", async () => {
    const state = await accepting();
    abort.abort();
    return state;
  });
  const running = f.start();
  await assert.rejects(f.launch.waitForStartup(abort.signal), /Cleanup exited/);
  await running.exited;
  await assert.rejects(readFile(join(f.launch.directory, "transferred")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.directory, "payload")), { code: "ENOENT" });
});

test("source death before transfer cannot be hidden by a fresh heartbeat", async (t) => {
  const f = await fixture(t, "sleep 0.3", { leaseMs: 10_000 });
  const source = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await once(source, "spawn");
  assert.ok(source.pid);
  const sourceExit = once(source, "exit");
  t.after(async () => {
    source.kill();
    await sourceExit;
  });
  await writeFile(
    join(f.launch.directory, "source"),
    JSON.stringify({ pid: source.pid, birth: await processBirth(source.pid) }),
  );
  const running = f.start();
  await phase(f.launch, "environment");
  source.kill("SIGKILL");
  await sourceExit;
  await running.exited;
  const state = await f.launch.read();
  assert.equal(state.kind, "exited");
  if (state.kind === "exited") assert.equal(state.reason, "sourceLost");
  await assert.rejects(readFile(join(f.directory, "payload")), { code: "ENOENT" });
  await assert.rejects(f.launch.transfer());
});

test("startup deadline stops only the owned process group", async (t) => {
  const f = await fixture(t, ":", { startupMs: 150, leaseMs: 2_000 });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const unrelatedExit = once(unrelated, "exit");
  t.after(async () => {
    unrelated.kill();
    await unrelatedExit;
  });
  const running = f.start("sleep 30; touch payload");
  await running.exited;
  const state = await f.launch.read();
  assert.equal(state.phase, "startup");
  assert.equal(state.kind, "exited");
  if (state.kind === "exited") assert.equal(state.reason, "timedout");
  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
  await assert.rejects(readFile(join(f.directory, "payload")), { code: "ENOENT" });
});

test("shell startup exit is distinguished from environment failure", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, ".bashrc"), "exit 31\n");
  const process = f.start();
  await process.exited;
  const state = await f.launch.read();
  assert.equal(state.phase, "shell");
  if (state.kind === "exited") assert.equal(state.code, 31);
  else assert.fail(JSON.stringify(state));
});

test("missing payload executable reports startup immediately rather than consuming its deadline", async (t) => {
  const f = await fixture(t);
  const command = `exec ${shellQuote(join(f.directory, "missing-pi-fixture"))}`;
  const expectedCode = spawnSync("sh", ["-c", command], { stdio: "ignore", timeout: 1_000 }).status;
  assert.ok(expectedCode === 126 || expectedCode === 127);
  await f.launch.pulse();
  const process = f.start(command);
  await process.exited;
  const state = await f.launch.read();
  assert.equal(state.kind, "exited");
  assert.equal(state.phase, "startup");
  if (state.kind === "exited") {
    assert.equal(state.code, expectedCode, process.stderr());
    assert.equal(state.reason, "failed");
  }
});

test("uncertain reservation ownership is retained until cleanup can be arbitrated", async (t) => {
  const f = await fixture(t, "sleep 30");
  const running = f.start();
  await phase(f.launch, "environment");
  const ownerPath = join(f.directory, "claim", "owner");
  const owner = await readFile(ownerPath, "utf8");
  await writeFile(ownerPath, "corrupted-owner");
  const stopped = await f.launch.stop("cancelled");
  assert.equal(stopped.kind, "recoveryRequired");
  assert.equal((await f.launch.read()).kind, "recoveryRequired");
  await assert.rejects(readFile(join(f.directory, "payload")), { code: "ENOENT" });
  await writeFile(ownerPath, owner);
  await running.exited;
  assert.equal((await f.launch.read()).kind, "exited");
  assert.equal(await f.readiness.read(), "stopped");
});

test("unresponsive transport retains a recoverable handle instead of claiming cleanup", async (t) => {
  const f = await fixture(t);
  const state = await f.launch.stop("cancelled");
  assert.equal(state.kind, "recoveryRequired");
  assert.equal(await readFile(join(f.launch.directory, "stop"), "utf8"), "cancelled");
  assert.equal((await f.launch.read()).kind, "active");
});

test("invalid, replaced, and out-of-phase launch receipts cannot authorize readiness", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.launch.assertAccepting(), /not accepting/);
  for (const value of [
    "{}",
    "not-json",
    JSON.stringify({ ...(await f.launch.read()), id: "replacement" }),
  ]) {
    await writeFile(f.launch.statusPath, value);
    await assert.rejects(f.launch.read());
  }
});
