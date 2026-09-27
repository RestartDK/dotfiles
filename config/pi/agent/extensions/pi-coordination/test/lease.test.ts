import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquire,
  encodeKey,
  groupConfirmedAbsent,
  readAttempt,
  readLease,
  resolveBlocked,
  runInForeground,
  startDetached,
  watch,
  type JobSpec,
  type WatchResult,
} from "../core.ts";

const roots: string[] = [];
const groups: number[] = [];

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "coord-test-"));
  roots.push(dir);
  return dir;
}

function spec(directory: string, over: Partial<JobSpec> = {}): JobSpec {
  return {
    resource: "test:shared",
    id: crypto.randomUUID(),
    owner: "test-owner",
    label: "synthetic",
    revision: "rev-1",
    cwd: directory,
    command: ["/bin/sh", "-c", "true"],
    ...over,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for a side effect");
}

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

afterEach(() => {
  for (const pgid of groups.splice(0)) killGroup(pgid);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("two takers, one wins, disjoint keys progress", async () => {
  const directory = root();
  const first = await acquire(directory, spec(directory, { id: "taker-one" }));
  expect(first.ok).toBe(true);

  const second = await acquire(directory, spec(directory, { id: "taker-two" }));
  expect(second.ok).toBe(false);
  if (second.ok) throw new Error("unreachable");
  expect(second.state.kind).toBe("held");

  const disjoint = await acquire(
    directory,
    spec(directory, { id: "taker-three", resource: "test:other" }),
  );
  expect(disjoint.ok).toBe(true);
  if (disjoint.ok) expect(disjoint.holder.id).toBe("taker-three");
});

test("the same id returns the existing attempt instead of running twice", async () => {
  const directory = root();
  const counter = join(directory, "runs");
  const job = spec(directory, {
    id: "duplicate-id",
    resource: "test:dedupe",
    command: ["/bin/sh", "-c", `printf 'run\\n' >> ${counter}`],
  });

  const first = await runInForeground(directory, job);
  expect(first.kind).toBe("settled");
  if (first.kind !== "settled") throw new Error("unreachable");
  expect(first.attempt.outcome).toBe("completed");

  const second = await runInForeground(directory, job);
  expect(second.kind).toBe("existing");
  expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
});

test("a detached command records its exit status and releases the key", async () => {
  const directory = root();
  const job = spec(directory, {
    id: "detached-status",
    resource: "test:detached",
    command: ["/bin/sh", "-c", "exit 7"],
  });

  const started = await startDetached(directory, job);
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("unreachable");

  let watched: WatchResult | undefined;
  await waitFor(() => {
    watched = watch(directory, job.id);
    return watched.kind === "settled";
  });
  if (watched?.kind !== "settled") throw new Error("unreachable");
  expect(watched.attempt.outcome).toBe("failed");
  expect(watched.attempt.exitCode).toBe(7);
  expect(readAttempt(directory, job.id)?.exitCode).toBe(7);
  expect(readLease(directory, job.resource).kind).toBe("free");
});

test("a client that stops watching does not free the key", async () => {
  const directory = root();
  const job = spec(directory, {
    id: "abandoned",
    resource: "test:abandoned",
    command: ["/bin/sh", "-c", "sleep 30"],
  });
  const started = await startDetached(directory, job);
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("unreachable");
  groups.push(started.pgid);

  const state = readLease(directory, job.resource);
  expect(state.kind).toBe("held");

  const contender = await acquire(
    directory,
    spec(directory, { id: "contender", resource: job.resource }),
  );
  expect(contender.ok).toBe(false);
});

test("a restart never replays a holder that died without recording an outcome", async () => {
  const directory = root();
  const counter = join(directory, "replays");
  const job = spec(directory, {
    id: "crashed",
    resource: "test:crash",
    command: ["/bin/sh", "-c", `printf 'run\\n' >> ${counter}; sleep 30`],
  });

  const started = await startDetached(directory, job);
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("unreachable");
  await waitFor(() => existsSync(counter));

  killGroup(started.pgid);
  await waitFor(() => groupConfirmedAbsent(started.pgid));

  const afterCrash = readLease(directory, job.resource);
  expect(afterCrash.kind).toBe("blocked");

  const replay = await runInForeground(
    directory,
    spec(directory, {
      id: "replay",
      resource: job.resource,
      command: ["/bin/sh", "-c", `printf 'run\\n' >> ${counter}`],
    }),
  );
  expect(replay.kind).toBe("refused");
  expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);

  const resolved = resolveBlocked(directory, "crashed", { inspected: true });
  expect(resolved.outcome).toBe("unknown");
  const granted = await acquire(
    directory,
    spec(directory, { id: "after-resolve", resource: job.resource }),
  );
  expect(granted.ok).toBe(true);
});

test("a surviving descendant keeps the key blocked after the command exits", async () => {
  const directory = root();
  const job = spec(directory, {
    id: "descendant",
    resource: "test:descendant",
    command: ["/bin/sh", "-c", "sleep 30 & exit 0"],
  });

  const result = await runInForeground(directory, job);
  expect(result.kind).toBe("settled");
  if (result.kind !== "settled") throw new Error("unreachable");
  expect(result.attempt.state).toBe("blocked");
  expect(result.attempt.outcome).toBe("completed");

  const state = readLease(directory, job.resource);
  expect(state.kind).toBe("blocked");
  if (state.kind !== "blocked") throw new Error("unreachable");
  expect(state.holder?.pgid).toBeDefined();
  groups.push(state.holder?.pgid ?? 0);

  const contender = await acquire(
    directory,
    spec(directory, { id: "blocked-contender", resource: job.resource }),
  );
  expect(contender.ok).toBe(false);
});

test("an unreadable or unknown-version lease record never reads as free", async () => {
  const directory = root();
  const resource = "test:corrupt";
  const leaseDir = join(directory, "leases", encodeKey(resource));

  mkdirSync(leaseDir, { recursive: true });
  writeFileSync(join(leaseDir, "holder"), "{ this is not json\n");
  expect(readLease(directory, resource).kind).toBe("blocked");
  const refused = await acquire(directory, spec(directory, { id: "corrupt-contender", resource }));
  expect(refused.ok).toBe(false);

  writeFileSync(
    join(leaseDir, "holder"),
    `${JSON.stringify({ version: 99, id: "future", owner: "someone", resource, startedAt: "now", state: "running" })}\n`,
  );
  expect(readLease(directory, resource).kind).toBe("blocked");
  expect((await acquire(directory, spec(directory, { id: "future-contender", resource }))).ok).toBe(
    false,
  );
});
