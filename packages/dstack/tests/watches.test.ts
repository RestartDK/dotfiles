import { expect, test } from "bun:test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  callJobs,
  number,
  record,
  string,
  parseSnapshot,
  subscribeJobs,
} from "../../../config/pi/agent/lib/dstack-jobs.ts";
import {
  callWatches,
  parseWatchRequest,
  parseWatchSnapshot,
  watchLimits,
  type WatchRegistration,
  type WatchView,
} from "../../../config/pi/agent/lib/dstack-watches.ts";
import { parseChecks } from "../src/watches.ts";
import { digest, freshJob } from "../src/domain.ts";
import { releaseProcess } from "../src/process.ts";

const node = process.env.DSTACK_TEST_NODE || "node";
const daemonEntry = fileURLToPath(new URL("./wake-daemon.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const exec = promisify(execFile);
const head = "a".repeat(40);
const completed = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
async function fixture() {
  const root = await mkdtemp("/tmp/dw-");
  const socket = join(root, "state/jobs.sock");
  const env = { ...process.env, DSTACK_WAKE_FIXTURE: root, DSTACK_SOCKET: socket };
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  const output: string[] = [];
  const observation = (
    response: unknown,
    extra: { delay?: number; unavailable?: boolean; recordOwnership?: boolean } = {},
  ) => writeFile(join(root, "github.json"), JSON.stringify({ response, ...extra }));
  await observation({ headRefOid: head, statusCheckRollup: [] });
  async function start() {
    child = spawn(node, [daemonEntry], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout?.on("data", (chunk) => output.push(String(chunk)));
    child.stderr?.on("data", (chunk) => output.push(String(chunk)));
    const current = child;
    exited = new Promise((resolve, reject) => {
      current.once("error", reject);
      current.once("exit", (code, signal) =>
        code === 0 || signal === "SIGKILL" ? resolve() : reject(new Error(output.join(""))),
      );
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Daemon readiness timeout ${output.join("")}`)),
        10_000,
      );
      current.once("message", () => {
        clearTimeout(timeout);
        resolve();
      });
      current.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(output.join("")));
      });
    });
  }
  async function stop(crash = false) {
    if (!child) return;
    child.kill(crash ? "SIGKILL" : "SIGTERM");
    await exited;
    child = undefined;
  }
  const call = (input: Parameters<typeof callWatches>[0]) => callWatches(input, { socket });
  async function wait(id: string, predicate: (watch: WatchView) => boolean): Promise<WatchView> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        off();
        reject(new Error(`Watch ${id} timed out ${output.join("")}`));
      }, 10_000);
      const off = subscribeJobs(
        (connection) => {
          if (connection.kind !== "online") return;
          const watch = connection.snapshot.watches?.find((w) => w.id === id);
          if (watch && predicate(watch)) {
            clearTimeout(timeout);
            off();
            resolve(watch);
          }
        },
        { socket, intervalMs: 20 },
      );
    });
  }
  async function create(registration: WatchRegistration) {
    const watch = (await call({ op: "create", registration })).watches[0];
    if (!watch) throw new Error("No admitted watch");
    return watch;
  }
  return {
    root,
    socket,
    env,
    start,
    stop,
    call,
    wait,
    observation,
    create,
    close: async () => {
      await stop();
      await writeFile(join(root, "daemon.log"), output.join(""));
      console.log(`Retained wake artifacts: ${root}`);
    },
  };
}
function timer(key: string, at = Date.now() + 500): WatchRegistration {
  return {
    requestId: key,
    sessionId: "native-session",
    trigger: { kind: "timer", at },
    deadline: at + 60_000,
    message: "Continue the requested work",
  };
}

test("watch boundary rejects broadcasts and malformed triggers; old snapshots remain readable", () => {
  for (const sessionId of [null, "", " ", "\n", "*"])
    expect(() =>
      parseWatchRequest({ op: "create", registration: { ...timer("bad"), sessionId } }),
    ).toThrow();
  expect(() =>
    parseWatchRequest({
      op: "create",
      registration: { ...timer("bad"), trigger: { kind: "shell", command: "true" } },
    }),
  ).toThrow();
  expect(() =>
    parseWatchRequest({
      op: "create",
      registration: {
        ...timer("bad"),
        trigger: { kind: "github-checks", repo: "--exec=x", pr: 1 },
      },
    }),
  ).toThrow();
  expect(parseSnapshot({ version: 1, now: 0, jobs: [] }).watches).toEqual([]);
});

test("GitHub requires nonempty fully parsed completed checks and reports failures", () => {
  for (const headRefOid of ["", "a".repeat(41), "z".repeat(40)])
    expect(() => parseChecks({ headRefOid, statusCheckRollup: [completed] })).toThrow();
  for (const statusCheckRollup of [
    [],
    [{ ...completed, status: "IN_PROGRESS" }],
    [{ __typename: "StatusContext", state: "PENDING" }],
    [{ __typename: "StatusContext", state: "EXPECTED" }],
  ])
    expect(parseChecks({ headRefOid: head, statusCheckRollup }).complete).toBe(false);
  for (const statusCheckRollup of [
    null,
    [{}],
    [{ ...completed, status: "unknown" }],
    [{ ...completed, conclusion: null }],
    [{ __typename: "StatusContext", state: "unknown" }],
  ])
    expect(() => parseChecks({ headRefOid: head, statusCheckRollup })).toThrow();
  expect(
    parseChecks({
      headRefOid: head,
      statusCheckRollup: [
        completed,
        { ...completed, conclusion: "FAILURE" },
        { __typename: "StatusContext", state: "ERROR" },
      ],
    }),
  ).toEqual({ head, complete: true, total: 3, failed: 2 });
});

test("built CLI timers survive restart, remain pending without a target, and claims exclude duplicate receivers", async () => {
  const f = await fixture();
  try {
    await f.start();
    const at = new Date(Date.now() + 1500).toISOString();
    const args = [
      "wake",
      "create",
      "--at",
      at,
      "--session",
      "native-session",
      "--message",
      "wake",
      "--request-id",
      "cli-retry",
    ];
    const admitted = parseWatchSnapshot(
      JSON.parse((await exec(node, [cli, ...args], { env: f.env })).stdout),
    );
    const watch = admitted.watches[0];
    if (!watch) throw new Error("Missing CLI admission");
    await writeFile(join(f.root, "cli-create.json"), JSON.stringify(admitted));
    expect(watch.trigger).toEqual({ kind: "timer", at: Date.parse(at) });
    const retry = parseWatchSnapshot(
      JSON.parse(
        (await exec(node, [cli, "wake", "create", "--request-id", "cli-retry"], { env: f.env }))
          .stdout,
      ),
    );
    expect(retry.watches[0]?.id).toBe(watch.id);
    await f.stop(true);
    await f.start();
    await f.wait(watch.id, (w) => w.state.kind === "pending");
    await f.stop(true);
    await f.start();
    expect((await f.call({ op: "status", id: watch.id })).watches[0]?.state.kind).toBe("pending");
    expect((await f.call({ op: "list", sessionId: "fork" })).watches).toEqual([]);
    await expect(
      f.call({ op: "begin", id: watch.id, sessionId: "fork", token: "wrong" }),
    ).rejects.toThrow("Wrong target");
    const claims = await Promise.allSettled(
      ["one", "two"].map((token) =>
        f.call({ op: "begin", id: watch.id, sessionId: "native-session", token }),
      ),
    );
    expect(claims.filter((c) => c.status === "fulfilled")).toHaveLength(1);
    const claimed = (await f.call({ op: "status", id: watch.id })).watches[0];
    if (!claimed || claimed.state.kind !== "delivering") throw new Error("Missing claim");
    const token = claimed.state.token;
    const second = await f.create(timer("second-claim", Date.now()));
    await f.wait(second.id, (w) => w.state.kind === "pending");
    await expect(
      f.call({ op: "begin", id: second.id, sessionId: "native-session", token: "competing" }),
    ).rejects.toThrow("outstanding delivery");
    await f.call({ op: "cancel", id: second.id });
    await expect(f.call({ op: "cancel", id: watch.id })).rejects.toThrow("already began");
    await f.stop(true);
    await f.start();
    await expect(
      f.call({ op: "begin", id: watch.id, sessionId: "native-session", token }),
    ).rejects.toThrow("uncertain");
    await expect(
      f.call({
        op: "ack",
        id: watch.id,
        sessionId: "native-session",
        token: "wrong",
        entryId: "entry",
      }),
    ).rejects.toThrow("Receipt");
    const ack = {
      op: "ack",
      id: watch.id,
      sessionId: "native-session",
      token,
      entryId: "entry",
    } satisfies Parameters<typeof callWatches>[0];
    await f.call(ack);
    expect((await f.call(ack)).watches[0]?.state.kind).toBe("delivered");
    const listing = await exec(node, [cli, "wake", "list"], { env: f.env });
    await writeFile(join(f.root, "cli-list.json"), listing.stdout);
    expect(parseWatchSnapshot(JSON.parse(listing.stdout)).watches[0]?.state.kind).toBe("delivered");
    expect((await callJobs({ op: "list" }, { socket: f.socket })).jobs).toEqual([]);
    const before = Date.now();
    const relative = parseWatchSnapshot(
      JSON.parse(
        (
          await exec(node, [cli, "wake", "create", "--in", "2m", "--message", "relative timer"], {
            env: { ...f.env, PI_SESSION_ID: "env-session" },
          })
        ).stdout,
      ),
    ).watches[0];
    if (!relative || relative.trigger.kind !== "timer") throw new Error("Missing relative timer");
    expect(relative.trigger.at).toBeGreaterThanOrEqual(before + 120_000);
    expect(relative.trigger.at).toBeLessThanOrEqual(Date.now() + 120_000);
    const status = parseWatchSnapshot(
      JSON.parse((await exec(node, [cli, "wake", "status", relative.id], { env: f.env })).stdout),
    );
    expect(status.watches[0]?.sessionId).toBe("env-session");
    const cancelled = parseWatchSnapshot(
      JSON.parse((await exec(node, [cli, "wake", "cancel", relative.id], { env: f.env })).stdout),
    );
    expect(cancelled.watches[0]?.state.kind).toBe("cancelled");
    await expect(
      exec(node, [cli, "wake", "create", "--in", "1m", "--message", "no broadcast"], {
        env: { ...f.env, PI_SESSION_ID: "" },
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
}, 30_000);

test("request keys distinguish deliberate duplicates and reject collisions; cancellation wins before claim", async () => {
  const f = await fixture();
  try {
    await f.start();
    const registration = timer("original", Date.now() + 5000);
    const one = await f.create(registration);
    expect((await f.create(registration)).id).toBe(one.id);
    await expect(f.create({ ...registration, message: "changed" })).rejects.toThrow("collision");
    const two = await f.create({ ...registration, requestId: "deliberate" });
    expect(two.id).not.toBe(one.id);
    await f.call({ op: "cancel", id: one.id });
    await f.stop();
    await f.start();
    expect((await f.call({ op: "cancel", id: one.id })).watches[0]?.state.kind).toBe("cancelled");
    await expect(
      f.call({ op: "begin", id: one.id, sessionId: "native-session", token: "claim" }),
    ).rejects.toThrow("not pending");
    await f.call({ op: "cancel", id: two.id });
    const pending = await f.create(timer("pending", Date.now()));
    await f.wait(pending.id, (w) => w.state.kind === "pending");
    expect((await f.call({ op: "cancel", id: pending.id })).watches[0]?.state.kind).toBe(
      "cancelled",
    );
    await expect(
      f.create({
        ...timer("expired"),
        deadline: Date.now() - 1,
        trigger: { kind: "timer", at: 0 },
      }),
    ).rejects.toThrow("Deadline");
    await expect(
      f.create({ ...timer("long"), deadline: Date.now() + 8 * 86400_000 }),
    ).rejects.toThrow("seven days");
  } finally {
    await f.close();
  }
}, 20_000);

test("existing jobs-v1 storage opens without migration or loss when the watch document is added", async () => {
  const f = await fixture();
  try {
    const job = freshJob(
      "f".repeat(24),
      { repo: "old/repo", pr: 17, source: f.root, mode: "observe" },
      1,
      8,
    );
    job.view.state = { kind: "terminal", outcome: "closed", reason: "Legacy retained PR" };
    await writeFile(join(f.root, "legacy-job.json"), JSON.stringify(job));
    await exec(node, [daemonEntry, "legacy"], { env: f.env });
    await f.start();
    const wake = await f.create(timer("new-watch", Date.now()));
    await f.wait(wake.id, (w) => w.state.kind === "pending");
    const snapshot = await callJobs({ op: "status", id: job.view.id }, { socket: f.socket });
    expect(snapshot.jobs[0]?.state).toEqual(job.view.state);
    expect(snapshot.jobs[0]?.repo).toBe("old/repo");
    expect(snapshot.watches?.[0]?.id).toBe(wake.id);
  } finally {
    await f.close();
  }
}, 15_000);

test("daemon restart quiesces an admission query that crashed before a watch was committed", async () => {
  const f = await fixture();
  let cleanupToken: string | undefined;
  const started = Promise.withResolvers<string>();
  const observer = createServer((connection) => {
    let value = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      value += chunk;
      if (value.length > 2048) {
        started.reject(new Error("Admission readiness frame too large"));
        connection.destroy();
      }
    });
    connection.once("error", started.reject);
    connection.once("end", () => started.resolve(value));
  });
  let listening = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      observer.once("error", reject);
      observer.listen(join(f.root, "admission-ready.sock"), resolve);
    });
    listening = true;
    observer.once("error", started.reject);
    timeout = setTimeout(
      () => started.reject(new Error("Admission process readiness deadline")),
      5000,
    );
    await f.start();
    await f.observation(
      { headRefOid: head, statusCheckRollup: [] },
      { delay: 20_000, recordOwnership: true },
    );
    const admission = f
      .create({
        ...timer("crashed-admission"),
        trigger: { kind: "github-checks", repo: "a/b", pr: 1 },
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    const ownership = record(JSON.parse(await started.promise));
    clearTimeout(timeout);
    cleanupToken = string(ownership.token);
    const pid = number(ownership.pid);
    expect(ownership.scope).toBe(digest(["watch-admission", join(f.root, "state")]));
    await f.stop(true);
    expect(await admission).toMatchObject({ error: expect.any(Error) });
    expect(await readFile(`/proc/${pid}/stat`, "utf8")).not.toMatch(/\)\s+Z\s/);
    await f.start();
    let live = false;
    try {
      live = !/\)\s+Z\s/.test(await readFile(`/proc/${pid}/stat`, "utf8"));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    expect(live).toBe(false);
    expect((await f.call({ op: "list" })).watches).toEqual([]);
  } finally {
    clearTimeout(timeout);
    if (cleanupToken) await releaseProcess(cleanupToken);
    if (listening)
      await new Promise<void>((resolve, reject) =>
        observer.close((error) => (error ? reject(error) : resolve())),
      );
    await f.close();
  }
}, 20_000);

test("watch admission enforces its active-count budget", async () => {
  const f = await fixture();
  try {
    await f.start();
    const at = Date.now() + 60_000;
    for (let i = 0; i < 64; i++) await f.create(timer(`capacity-${i}`, at));
    await expect(f.create(timer("overflow", at))).rejects.toThrow("capacity");
    await f.stop(true);
  } finally {
    await f.close();
  }
}, 20_000);

test("GitHub observations pin head, reject malformed/unavailable data, expire and cannot overwrite cancellation", async () => {
  const f = await fixture();
  try {
    await f.start();
    const base = {
      ...timer("checks"),
      trigger: { kind: "github-checks", repo: "a/b", pr: 1 },
    } satisfies WatchRegistration;
    const watch = await f.create(base);
    expect(watch.trigger).toEqual({ ...base.trigger, head });
    await f.wait(watch.id, (w) => w.state.kind === "watching" && w.state.observations > 0);
    await f.observation({ headRefOid: head, statusCheckRollup: [{}] });
    await f.wait(watch.id, (w) => w.state.kind === "watching" && w.state.error !== null);
    await f.observation({}, { unavailable: true });
    await f.wait(
      watch.id,
      (w) => w.state.kind === "watching" && w.state.error?.includes("External process") === true,
    );
    await f.observation({ headRefOid: "b".repeat(40), statusCheckRollup: [completed] });
    expect((await f.wait(watch.id, (w) => w.state.kind === "superseded")).state.kind).toBe(
      "superseded",
    );
    await f.observation({ headRefOid: head, statusCheckRollup: [] });
    const expiring = await f.create({ ...base, requestId: "expires", deadline: Date.now() + 1300 });
    await f.observation({}, { unavailable: true });
    await f.wait(expiring.id, (w) => w.state.kind === "expired");
    await f.observation({ headRefOid: head, statusCheckRollup: [] });
    const cancelled = await f.create({ ...base, requestId: "cancel-race" });
    await f.observation({ headRefOid: head, statusCheckRollup: [completed] }, { delay: 250 });
    await f.call({ op: "cancel", id: cancelled.id });
    await f.stop();
    await f.start();
    expect((await f.call({ op: "status", id: cancelled.id })).watches[0]?.state.kind).toBe(
      "cancelled",
    );
    await f.observation({
      headRefOid: head,
      statusCheckRollup: [completed, { ...completed, conclusion: "FAILURE" }],
    });
    const done = await f.create({ ...base, requestId: "complete" });
    const result = await f.wait(done.id, (w) => w.state.kind === "pending");
    expect(result.state).toEqual({
      kind: "pending",
      result: { kind: "checks", head, total: 2, failed: 1 },
    });
    await expect(
      f.create({
        ...base,
        requestId: "admission-error",
        trigger: { kind: "github-checks", repo: "a/b", pr: 2 },
        deadline: Date.now() + 1,
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
}, 30_000);

test("Unix clients read escaped retained-capacity watches alongside the legacy jobs payload", async () => {
  const root = await mkdtemp("/tmp/dw-wire-");
  const socket = join(root, "jobs.sock");
  const now = Date.now();
  const watches = Array.from({ length: watchLimits.retained }, (_, i): WatchView => {
    const registration = {
      ...timer(String(i).padStart(200, "r"), now),
      trigger: { kind: "timer", at: now } satisfies WatchView["trigger"],
      sessionId: "s".repeat(200),
      message: "\u0001".repeat(1950) + '"'.repeat(2050),
    };
    const request = { op: "create", registration };
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(16_384);
    parseWatchRequest(request);
    return {
      ...registration,
      id: i.toString(16).padStart(24, "0"),
      createdAt: now,
      updatedAt: now,
      state: {
        kind: "delivered",
        result: { kind: "timer", at: now },
        token: "t".repeat(200),
        entryId: "e".repeat(200),
      },
    };
  });
  const job = freshJob(
    "f".repeat(24),
    { repo: "old/repo", pr: 1, source: root, mode: "observe" },
    now,
    8,
  ).view;
  job.state = { kind: "terminal", outcome: "stopped", reason: "Stopped" };
  job.history = [{ at: now, event: "x".repeat(8 * 1024 * 1024 - 2048) }];
  const legacy = { version: 1, now, jobs: [job] };
  expect(Buffer.byteLength(JSON.stringify(legacy))).toBeLessThan(8 * 1024 * 1024);
  const watchPayload = JSON.stringify({ version: 1, now, watches });
  expect(Buffer.byteLength(watchPayload)).toBeGreaterThan(16 * 1024 * 1024);
  const jobsPayload = JSON.stringify({ ...legacy, watches });
  const server = createHttpServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/v1/watches" ? watchPayload : jobsPayload);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    const results = await Promise.allSettled([
      callWatches({ op: "list" }, { socket }),
      callJobs({ op: "list" }, { socket }),
    ]);
    const jobsModule = fileURLToPath(
      new URL("../../../config/pi/agent/lib/dstack-jobs.ts", import.meta.url),
    );
    const watchesModule = fileURLToPath(
      new URL("../../../config/pi/agent/lib/dstack-watches.ts", import.meta.url),
    );
    const { stdout } = await exec(node, [
      "--input-type=module",
      "-e",
      `
      import { callJobs } from ${JSON.stringify(jobsModule)};
      import { callWatches } from ${JSON.stringify(watchesModule)};
      const options = { socket: ${JSON.stringify(socket)} };
      const snapshots = await Promise.all([
        callWatches({ op: "list" }, options), callJobs({ op: "list" }, options),
      ]);
      process.stdout.write(JSON.stringify(snapshots.map(snapshot => ({
        count: snapshot.watches.length,
        first: snapshot.watches[0],
        last: snapshot.watches.at(-1),
        legacyBytes: "jobs" in snapshot ? snapshot.jobs[0].history[0].event.length : null,
      }))));
    `,
    ]);
    const edges = { count: watches.length, first: watches[0], last: watches.at(-1) };
    expect(JSON.parse(stdout)).toEqual([
      { ...edges, legacyBytes: null },
      { ...edges, legacyBytes: job.history[0]?.event.length },
    ]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      expect(result.value.watches).toEqual(watches);
      if ("jobs" in result.value) expect(result.value.jobs).toEqual([job]);
    }
    console.log(
      `Retained capacity wire bytes: watches=${Buffer.byteLength(watchPayload)} jobs=${Buffer.byteLength(jobsPayload)}`,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 15_000);
