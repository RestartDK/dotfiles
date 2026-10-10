import { expect, test } from "bun:test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  agentPrefix,
  array,
  authorGate,
  callJobs,
  record,
  string,
  subscribeJobs,
  type JobView,
  type Snapshot,
} from "../../../config/pi/agent/lib/dstack-jobs.ts";

import { digest } from "../src/domain.ts";
import { releaseProcess, releaseScope } from "../src/process.ts";

const exec = promisify(execFile);
const node = process.env.DSTACK_TEST_NODE || "node";
const daemonEntry = fileURLToPath(new URL("./daemon-fixture.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const terminalCrashHook = fileURLToPath(new URL("./terminal-crash-hook.mjs", import.meta.url));
const roles = [
  "feature",
  "refactoring",
  "swarm-workers",
  "bug-fix",
  "perf-issue",
  "hillclimb",
  "fast-code",
  "precise-code",
  "prose",
  "judgment",
  "review",
  "hardest",
  "how-explorer",
  "how-explainer",
  "how-critics",
  "why-investigators",
  "why-synthesizer",
  "reflect-judgment",
  "reflect-tooling",
  "reflect-divergent",
  "reflect-synthesizer",
  "arena-runners",
  "arena-cross-judge",
  "architect-runners",
  "interrogate-reviewers",
];
const human = {
  id: "T1",
  kind: "human",
  decision: "unanswered",
  author: "reviewer",
  url: "https://github.com/a/b/pull/1#discussion_r1",
  body: "Fix the defect",
  direction: "",
};
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec("git", args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    })
  ).stdout.trim();

async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp("/tmp/dj-");
  const source = join(root, "source");
  const remote = join(root, "remote");
  await mkdir(source);
  await git(root, "init", "--bare", remote);
  await git(source, "init", "-b", "repair");
  await git(source, "config", "user.name", "Fixture");
  await git(source, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(source, "app.txt"), "broken\n");
  await git(source, "add", "app.txt");
  await git(source, "commit", "-m", "fixture");
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "origin", "repair");
  await mkdir(join(root, "config/dstack"), { recursive: true });
  await writeFile(
    join(root, "config/dstack/models.json"),
    JSON.stringify({
      version: 1,
      profile: "personal",
      providers: ["openai"],
      parent: "test",
      routes: { test: [{ kind: "pi", model: "openai/fixture", thinking: "high" }] },
      roles: Object.fromEntries(roles.map((role) => [role, { kind: "single", route: "test" }])),
    }),
  );
  const initial = {
    lifecycle: "OPEN",
    conflict: false,
    offline: false,
    failing: [],
    threads: [],
    comments: [],
    issueComments: [],
    resolved: [],
    reviewers: [],
    reviewRequests: 0,
    ...overrides,
  };
  await writeFile(join(root, "github.json"), JSON.stringify(initial));
  const socket = join(root, "state/jobs.sock");
  const env = {
    ...process.env,
    DSTACK_FIXTURE_ROOT: root,
    DSTACK_SOCKET: socket,
    DSTACK_STATE_DIR: join(root, "state"),
    DSTACK_FIXTURE_RUNNER: process.execPath,
  };
  let daemon: ChildProcess | null = null;
  const admitted = new Set<string>();
  async function start(
    options: { recovery?: Pick<PromiseWithResolvers<void>, "resolve" | "reject"> } = {},
  ) {
    const recovery = options.recovery;
    const child = spawn(node, ["--import", terminalCrashHook, daemonEntry], {
      env,
      stdio: recovery ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    });
    daemon = child;
    let log = "";
    if (recovery) {
      child.on("message", (value: unknown) => {
        try {
          const message = record(value);
          if (message.kind === "dstack-test.recovered") recovery.resolve();
          else if (message.kind === "dstack-test.failed")
            recovery.reject(new Error(string(message.reason)));
          else recovery.reject(new Error("Unexpected recovery fixture message"));
        } catch (error) {
          recovery.reject(error);
        }
      });
      child.once("exit", (code, signal) =>
        recovery.reject(new Error(`Recovery daemon exited ${code ?? signal}: ${log}`)),
      );
      child.once("disconnect", () =>
        recovery.reject(new Error(`Recovery daemon disconnected: ${log}`)),
      );
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      log += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Daemon startup deadline: ${log}`));
      }, 10_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Daemon exited ${code}: ${log}`));
      });
      child.stdout?.on("data", (chunk: string) => {
        log += chunk;
        if (log.includes("READY\n")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    return child;
  }
  async function shutdown(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
    const child = daemon;
    try {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Daemon did not quiesce"));
        }, 15_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      child.kill(signal);
      await exited;
    } finally {
      daemon = null;
      if (signal === "SIGTERM") {
        for (const call of calls()) await releaseProcess(string(call.token));
        for (const id of admitted) await releaseScope(digest(["io", id]));
      }
    }
  }
  async function patch(change: Record<string, unknown>) {
    const current = record(JSON.parse(await readFile(join(root, "github.json"), "utf8")));
    await writeFile(join(root, "github-test.json"), JSON.stringify({ ...current, ...change }));
    await rename(join(root, "github-test.json"), join(root, "github.json"));
  }
  const state = () => record(JSON.parse(readFileSync(join(root, "github.json"), "utf8")));
  const calls = () =>
    existsSync(join(root, "workers.jsonl"))
      ? readFileSync(join(root, "workers.jsonl"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => record(JSON.parse(line)))
      : [];
  const request = (input: Parameters<typeof callJobs>[0]) => callJobs(input, { socket });
  const register = async (mode: "observe" | "drive") => {
    const job = first(
      await request({ op: "register", registration: { repo: "a/b", pr: 1, source, mode } }),
    );
    admitted.add(job.id);
    return job;
  };
  console.info(`Retained acceptance artifacts: ${root}`);
  return {
    root,
    source,
    remote,
    socket,
    env,
    start,
    shutdown,
    patch,
    state,
    calls,
    request,
    register,
  };
}
function first(snapshot: Snapshot): JobView {
  const job = snapshot.jobs[0];
  if (!job) throw new Error("Expected admitted job");
  return job;
}
function until(
  socket: string,
  predicate: (jobs: JobView[]) => boolean,
  timeoutMs = 60_000,
): Promise<JobView[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      disconnect();
      reject(new Error("Job state deadline exceeded"));
    }, timeoutMs);
    const disconnect = subscribeJobs(
      (connection) => {
        if (connection.kind !== "online" || !predicate(connection.snapshot.jobs)) return;
        clearTimeout(timer);
        disconnect();
        resolve(connection.snapshot.jobs);
      },
      { socket, intervalMs: 40 },
    );
  });
}

test("real CLI admission, exclusivity, private IPC, disconnect, restart, offline recovery and closed archive", async () => {
  const f = await fixture();
  try {
    await f.start();
    expect((await f.request({ op: "list" })).jobs).toEqual([]);
    const result = await exec(
      node,
      [cli, "register", "--repo", "a/b", "--pr", "1", "--source", f.source, "--mode", "observe"],
      { env: f.env },
    );
    const admitted = record(array(record(JSON.parse(result.stdout)).jobs)[0]);
    const job = await f.register("observe");
    expect(job.id).toBe(string(admitted.id));
    expect((await stat(f.socket)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.root, "state"))).mode & 0o777).toBe(0o700);
    await expect(exec(node, [daemonEntry], { env: f.env })).rejects.toThrow();
    const disconnect = subscribeJobs(() => {}, { socket: f.socket });
    disconnect();
    await f.patch({ offline: true });
    await until(f.socket, (jobs) => jobs[0]?.state.kind === "blocked");
    await f.shutdown();
    await f.start();
    expect(first(await f.request({ op: "status", id: job.id })).id).toBe(job.id);
    await f.patch({ offline: false });
    await until(
      f.socket,
      (jobs) => jobs[0]?.state.kind === "watching" && jobs[0].observedAt !== null,
    );
    await f.patch({ lifecycle: "CLOSED" });
    const jobs = await until(f.socket, (jobs) => jobs[0]?.state.kind === "terminal");
    expect(jobs[0]?.state).toMatchObject({ kind: "terminal", outcome: "closed" });
    expect(await readFile(join(f.source, "app.txt"), "utf8")).toBe("broken\n");
    expect(f.calls()).toEqual([]);
  } finally {
    await f.shutdown();
  }
}, 60_000);

test("human verdict waits across restart, author approval repairs owning branch, replies once and merge releases only owned resources", async () => {
  const f = await fixture({ threads: [human] });
  try {
    const original = await git(f.source, "rev-parse", "HEAD");
    await f.start();
    const job = await f.register("drive");
    await until(
      f.socket,
      (jobs) => jobs[0]?.state.kind === "watching" && array(f.state().comments).length === 1,
    );
    const pending = string(record(array(f.state().comments)[0]).body);
    expect(pending.startsWith(agentPrefix)).toBe(true);
    expect(pending.endsWith(authorGate)).toBe(true);
    expect(f.calls().map((call) => call.operation)).toEqual(["triage"]);
    await f.shutdown();
    await f.start();
    const before = first(await f.request({ op: "status", id: job.id })).observedAt ?? 0;
    await until(f.socket, (jobs) => (jobs[0]?.observedAt ?? 0) > before);
    expect(f.calls()).toHaveLength(1);
    await f.patch({ threads: [{ ...human, decision: "implement" }] });
    await until(
      f.socket,
      (jobs) => jobs[0]?.state.kind === "watching" && f.state().reviewRequests === 1,
    );
    const remote = await git(f.root, "--git-dir", f.remote, "rev-parse", "refs/heads/repair");
    expect(remote).not.toBe(original);
    expect(await git(f.source, "rev-parse", "HEAD")).toBe(original);
    expect(await readFile(join(f.source, "app.txt"), "utf8")).toBe("broken\n");
    expect(array(f.state().resolved)).toEqual(["T1"]);
    const comments = array(f.state().comments).map((c) => string(record(c).body));
    expect(comments).toHaveLength(2);
    expect(comments[1]?.startsWith(`${agentPrefix}Fixed in ${remote}:`)).toBe(true);
    expect(f.calls().map((call) => call.operation)).toEqual(["triage", "repair"]);
    await f.patch({ lifecycle: "MERGED" });
    const terminal = (await until(f.socket, (jobs) => jobs[0]?.state.kind === "terminal"))[0];
    expect(terminal?.state).toMatchObject({ outcome: "merged" });
    expect(terminal?.resources.find((r) => r.kind === "worker")?.disposition).toBe("released");
    const worktree = terminal?.resources.find((r) => r.kind === "worktree");
    if (!worktree) throw new Error("Missing retained worktree");
    expect(worktree.disposition).toBe("retained");
    expect(await readFile(join(worktree.handle, "app.txt"), "utf8")).toBe("fixed\n");
    expect(await git(f.source, "worktree", "list", "--porcelain")).not.toContain(
      `locked dstack:${job.id}`,
    );
    await f.shutdown();
    await f.start();
    expect(first(await f.request({ op: "status", id: job.id })).state).toMatchObject({
      kind: "terminal",
      outcome: "merged",
    });
  } finally {
    await f.shutdown();
  }
}, 120_000);

test("remote reply persisted before failure is reconciled by marker without a duplicate worker or comment", async () => {
  const f = await fixture({ threads: [human], failAfterReply: true });
  try {
    await f.start();
    const job = await f.register("drive");
    await until(f.socket, (jobs) => jobs[0]?.pending.some((p) => p.includes("uncertain")) === true);
    await f.shutdown();
    await f.start();
    await until(
      f.socket,
      (jobs) => jobs[0]?.state.kind === "watching" && jobs[0].pending.length === 0,
    );
    expect(array(f.state().comments)).toHaveLength(1);
    expect(f.calls()).toHaveLength(1);
    await f.request({ op: "stop", id: job.id });
    await until(f.socket, (jobs) => jobs[0]?.state.kind === "terminal");
  } finally {
    await f.shutdown();
  }
}, 90_000);

test("crash with a real native subprocess quiesces registered processes and blocks replay, then stop retains data", async () => {
  const f = await fixture({ failing: ["build"], hangWorker: true });
  try {
    await f.start();
    const job = await f.register("drive");
    await until(f.socket, (jobs) => jobs[0]?.state.kind === "working" && f.calls().length === 1);
    await f.shutdown("SIGKILL");
    await f.start();
    await until(
      f.socket,
      (jobs) =>
        jobs[0]?.state.kind === "blocked" &&
        jobs[0].resources.some((r) => r.kind === "worker" && r.disposition === "released"),
    );
    expect(f.calls()).toHaveLength(1);
    const call = f.calls()[0];
    if (!call) throw new Error("Missing interrupted worker");
    try {
      const env = await readFile(`/proc/${String(call.pid)}/environ`, "utf8");
      expect(env.split("\0")).not.toContain(`DSTACK_PROCESS_TOKEN=${String(call.token)}`);
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    await f.request({ op: "stop", id: job.id });
    const jobs = await until(f.socket, (jobs) => jobs[0]?.state.kind === "terminal");
    expect(jobs[0]?.state).toMatchObject({ outcome: "stopped" });
    expect(jobs[0]?.resources.find((r) => r.kind === "worktree")?.disposition).toBe("retained");
  } finally {
    await f.shutdown();
  }
}, 90_000);

test("conflicts stop code work before CI, then CI logs drive one branch-only repair", async () => {
  const f = await fixture({ conflict: true, failing: ["build"] });
  try {
    await f.start();
    const job = await f.register("drive");
    await until(
      f.socket,
      (jobs) => jobs[0]?.state.kind === "blocked" && jobs[0].state.reason.includes("Conflict"),
    );
    expect(f.calls()).toEqual([]);
    await f.patch({ conflict: false });
    await until(
      f.socket,
      (jobs) => jobs[0]?.state.kind === "watching" && jobs[0].verdict === "READY",
    );
    expect(f.calls().map((call) => call.operation)).toEqual(["repair"]);
    const call = f.calls()[0];
    if (!call) throw new Error("Missing CI worker");
    expect(array(record(call.evidence).ciLogs)).toHaveLength(1);
    expect(await git(f.root, "--git-dir", f.remote, "show", "refs/heads/repair:app.txt")).toBe(
      "fixed",
    );
    expect(await readFile(join(f.source, "app.txt"), "utf8")).toBe("broken\n");
    await f.request({ op: "stop", id: job.id });
    await until(f.socket, (jobs) => jobs[0]?.state.kind === "terminal");
  } finally {
    await f.shutdown();
  }
}, 90_000);

test("failed ownership verification keeps cleanup pending and preserves a changed worktree lock", async () => {
  const f = await fixture({ threads: [human] });
  try {
    await f.start();
    const job = await f.register("drive");
    const ready = (
      await until(
        f.socket,
        (jobs) => jobs[0]?.state.kind === "watching" && array(f.state().comments).length === 1,
      )
    )[0];
    const owned = ready?.resources.find((resource) => resource.kind === "worktree");
    if (!owned) throw new Error("Missing owned checkout");
    await git(f.source, "worktree", "unlock", owned.handle);
    await git(f.source, "worktree", "lock", "--reason", "borrowed-lock", owned.handle);
    await f.request({ op: "stop", id: job.id });
    await until(
      f.socket,
      (jobs) => jobs[0]?.state.kind === "cleanup" && jobs[0].state.reason.includes("changed"),
    );
    expect(await git(f.source, "worktree", "list", "--porcelain")).toContain(
      "locked borrowed-lock",
    );
    expect(await readFile(join(owned.handle, "app.txt"), "utf8")).toBe("broken\n");
    await git(f.source, "worktree", "unlock", owned.handle);
    await git(f.source, "worktree", "lock", "--reason", `dstack:${job.id}`, owned.handle);
    await until(f.socket, (jobs) => jobs[0]?.state.kind === "terminal");
  } finally {
    await f.shutdown();
  }
}, 90_000);

test("bot dismissal resolves and requests re-review without edits or push", async () => {
  const f = await fixture({
    threads: [{ ...human, kind: "bot", author: "cursor[bot]", decision: "implement" }],
    verdicts: { T1: "dismiss" },
  });
  try {
    const original = await git(f.source, "rev-parse", "HEAD");
    await f.start();
    const job = await f.register("drive");
    await until(
      f.socket,
      (jobs) => jobs[0]?.state.kind === "watching" && array(f.state().issueComments).length === 1,
    );
    expect(array(f.state().resolved)).toEqual(["T1"]);
    expect(string(record(array(f.state().issueComments)[0]).body).startsWith(agentPrefix)).toBe(
      true,
    );
    expect(await git(f.root, "--git-dir", f.remote, "rev-parse", "refs/heads/repair")).toBe(
      original,
    );
    expect(f.calls()).toHaveLength(1);
    await f.request({ op: "stop", id: job.id });
    await until(f.socket, (jobs) => jobs[0]?.state.kind === "terminal");
  } finally {
    await f.shutdown();
  }
}, 90_000);

test("reopened bot generations receive new remote replies and re-review receipts", async () => {
  const original = { ...human, kind: "bot", author: "cursor[bot]", decision: "implement" };
  const f = await fixture({ threads: [original], verdicts: { T1: "dismiss" } });
  try {
    await f.start();
    const job = await f.register("drive");
    await until(
      f.socket,
      (jobs) => jobs[0]?.state.kind === "watching" && array(f.state().issueComments).length === 1,
    );
    await f.patch({ threads: [{ ...original, body: "A second distinct finding" }], resolved: [] });
    await until(
      f.socket,
      (jobs) => jobs[0]?.state.kind === "watching" && array(f.state().issueComments).length === 2,
    );
    expect(array(f.state().comments)).toHaveLength(2);
    expect(f.calls()).toHaveLength(2);
    const bodies = array(f.state().comments).map((entry) => string(record(entry).body));
    expect(new Set(bodies).size).toBe(2);
    await f.shutdown();
    await f.start();
    await until(
      f.socket,
      (jobs) => jobs[0]?.state.kind === "watching" && jobs[0].pending.length === 0,
    );
    expect(array(f.state().comments)).toHaveLength(2);
    expect(array(f.state().issueComments)).toHaveLength(2);
    await f.request({ op: "stop", id: job.id });
    await until(f.socket, (jobs) => jobs[0]?.state.kind === "terminal");
  } finally {
    await f.shutdown();
  }
}, 150_000);

test("closed-job cleanup cannot be abandoned when the PR reopens", async () => {
  const f = await fixture({ threads: [human] });
  try {
    await f.start();
    const job = await f.register("drive");
    const ready = (
      await until(
        f.socket,
        (jobs) => jobs[0]?.state.kind === "watching" && array(f.state().comments).length === 1,
      )
    )[0];
    const owned = ready?.resources.find((resource) => resource.kind === "worktree");
    if (!owned) throw new Error("Missing owned checkout");
    await git(f.source, "worktree", "unlock", owned.handle);
    await git(f.source, "worktree", "lock", "--reason", "borrowed-lock", owned.handle);
    await f.patch({ lifecycle: "CLOSED" });
    await until(
      f.socket,
      (jobs) => jobs[0]?.state.kind === "cleanup" && jobs[0].state.reason.includes("changed"),
    );
    const count = f.calls().length;
    await f.patch({
      lifecycle: "OPEN",
      threads: [{ ...human, kind: "owner", author: "daniel", decision: "implement" }],
    });
    await git(f.source, "worktree", "unlock", owned.handle);
    await git(f.source, "worktree", "lock", "--reason", `dstack:${job.id}`, owned.handle);
    const terminal = (await until(f.socket, (jobs) => jobs[0]?.state.kind === "terminal"))[0];
    expect(terminal?.state.kind === "terminal" ? terminal.state.outcome : null).toBe("closed");
    expect(f.calls()).toHaveLength(count);
    expect(array(f.state().comments)).toHaveLength(1);
  } finally {
    await f.shutdown();
  }
}, 120_000);

test("dirty repair without a selected fix retains edits and never publishes", async () => {
  const f = await fixture({
    threads: [{ ...human, kind: "owner", author: "daniel", decision: "implement" }],
    verdicts: { T1: "dismiss" },
  });
  try {
    const original = await git(f.source, "rev-parse", "HEAD");
    await f.start();
    const job = await f.register("drive");
    const blocked = (
      await until(
        f.socket,
        (jobs) =>
          jobs[0]?.state.kind === "blocked" &&
          jobs[0].history.some((item) => item.event.includes("Dirty repair")),
      )
    )[0];
    const owned = blocked?.resources.find((resource) => resource.kind === "worktree");
    if (!owned) throw new Error("Missing retained checkout");
    expect(await readFile(join(owned.handle, "app.txt"), "utf8")).toBe("fixed\n");
    expect(await git(f.root, "--git-dir", f.remote, "rev-parse", "refs/heads/repair")).toBe(
      original,
    );
    expect(array(f.state().comments)).toHaveLength(0);
    expect(f.calls()).toHaveLength(1);
    await f.request({ op: "stop", id: job.id });
    await until(f.socket, (jobs) => jobs[0]?.state.kind === "terminal");
  } finally {
    await f.shutdown();
  }
}, 90_000);

test("mixed supported and external CI failures block before any blind repair", async () => {
  const f = await fixture({
    failing: ["build", "external"],
    checks: [
      { name: "build", detailsUrl: "https://github.com/a/b/actions/runs/123/job/456" },
      { context: "external", state: "FAILURE" },
    ],
  });
  try {
    await f.start();
    const job = await f.register("drive");
    await until(
      f.socket,
      (jobs) =>
        jobs[0]?.state.kind === "blocked" &&
        jobs[0].state.reason.includes("CI logs unavailable for external"),
    );
    expect(f.calls()).toEqual([]);
    expect(await readFile(join(f.source, "app.txt"), "utf8")).toBe("broken\n");
    await f.request({ op: "stop", id: job.id });
    await until(f.socket, (jobs) => jobs[0]?.state.kind === "terminal");
  } finally {
    await f.shutdown();
  }
}, 90_000);

test("oversized shared-run CI logs block instead of erasing a selected job's evidence", async () => {
  const f = await fixture({
    failing: ["build", "test"],
    checks: [
      { name: "build", detailsUrl: "https://github.com/a/b/actions/runs/123/job/456" },
      { name: "test", detailsUrl: "https://github.com/a/b/actions/runs/123/job/457" },
    ],
    ciLog: "build: early selected failure\n" + "test: later output\n".repeat(4000),
  });
  try {
    await f.start();
    const job = await f.register("drive");
    await until(
      f.socket,
      (jobs) =>
        jobs[0]?.state.kind === "blocked" &&
        jobs[0].state.reason.includes("CI evidence exceeds worker limit"),
    );
    expect(f.calls()).toEqual([]);
    await f.request({ op: "stop", id: job.id });
    await until(f.socket, (jobs) => jobs[0]?.state.kind === "terminal");
  } finally {
    await f.shutdown();
  }
}, 90_000);

async function boundedEvent<T>(event: Promise<T>, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      event,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), 60_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("terminal document saved before task completion survives SIGKILL and PR reopening", async () => {
  const f = await fixture();
  try {
    const child = await f.start();
    const killed = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once("exit", (_code, signal) => resolve(signal));
    });
    const job = await f.register("drive");
    await until(f.socket, (jobs) => jobs[0]?.observedAt !== null);
    await writeFile(join(f.root, "kill-terminal"), "armed\n");
    const receipt = join(f.root, "terminal-crash-receipt.json");
    await f.patch({ lifecycle: "CLOSED" });
    expect(await boundedEvent(killed, "Terminal crash boundary was not reached")).toBe("SIGKILL");
    await f.shutdown("SIGKILL");
    const proof = record(JSON.parse(await readFile(receipt, "utf8")));
    expect(array(proof.states).map((state) => record(state).kind)).toEqual(["terminal"]);
    expect(array(proof.tasks).map((task) => record(task).status)).toEqual(["running"]);
    await f.patch({
      lifecycle: "OPEN",
      threads: [{ ...human, kind: "owner", author: "daniel", decision: "implement" }],
    });
    const completion = join(f.root, "recovered-task-completion.json");
    const completed = Promise.withResolvers<void>();
    await Promise.all([
      f.start({ recovery: completed }),
      boundedEvent(completed.promise, "Recovered durable task did not complete"),
    ]);
    const settled = record(JSON.parse(await readFile(completion, "utf8")));
    expect(array(settled.tasks).map((task) => record(task).status)).toEqual(["terminal"]);
    expect(array(settled.outcomes)).toEqual([{ status: "completed", result: "closed" }]);
    expect(array(settled.states)).toMatchObject([{ kind: "terminal", outcome: "closed" }]);
    const recovered = first(await f.request({ op: "status", id: job.id }));
    expect(recovered.state).toMatchObject({ kind: "terminal", outcome: "closed" });
    expect(f.calls()).toEqual([]);
  } finally {
    await f.shutdown();
  }
}, 90_000);
