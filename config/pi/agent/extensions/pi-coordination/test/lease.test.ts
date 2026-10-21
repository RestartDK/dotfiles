import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquire,
  cancelAttempt,
  encodeKey,
  groupConfirmedAbsent,
  readAttempt,
  readLease,
  resolveBlocked,
  runInForeground,
  startDetached,
  watch,
  type Holder,
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

test("a status file does not release a key while the process group is alive", async () => {
  const directory = root();
  const job = spec(directory, {
    id: "live-group",
    resource: "test:live",
    command: ["/bin/sh", "-c", "sleep 30"],
  });
  const started = await startDetached(directory, job);
  expect(started.kind).toBe("started");
  if (started.kind !== "started") throw new Error("unreachable");
  groups.push(started.pgid);

  writeFileSync(join(directory, "attempts", "live-group.status"), "0\n");
  expect(readLease(directory, job.resource).kind).toBe("held");
  expect(watch(directory, job.id).kind).toBe("running");
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

test("cancel can stop live descendants of an already completed command", async () => {
  const directory = root();
  const job = spec(directory, {
    id: "cancel-descendant",
    resource: "test:cancel-descendant",
    command: ["/bin/sh", "-c", "sleep 30 & exit 0"],
  });
  const ended = await runInForeground(directory, job);
  if (ended.kind !== "settled") throw new Error("The parent command did not end");
  expect(ended.attempt.state).toBe("blocked");
  const state = readLease(directory, job.resource);
  if (state.kind !== "blocked" || state.holder?.pgid === undefined)
    throw new Error("The descendant group was not retained");
  const pgid = state.holder.pgid;
  groups.push(pgid);
  expect(groupConfirmedAbsent(pgid)).toBe(false);
  expect(cancelAttempt(directory, job.id).kind).toBe("cancelled");
  await waitFor(() => groupConfirmedAbsent(pgid));
  const settled = watch(directory, job.id);
  if (settled.kind !== "settled") throw new Error("Cancellation did not settle");
  expect(settled.attempt.outcome).toBe("cancelled");
  expect(readLease(directory, job.resource).kind).toBe("free");
});

async function abandoned(directory: string, id: string): Promise<Holder> {
  const acquired = await acquire(directory, spec(directory, { id }));
  if (!acquired.ok) throw new Error("Fixture lease was not acquired");
  const pgid = 1_000_000_000;
  if (!groupConfirmedAbsent(pgid)) throw new Error("Fixture process group is not absent");
  const holder: Holder = { ...acquired.holder, pgid, state: "running" };
  writeFileSync(
    join(directory, "leases", encodeKey(holder.resource), "holder"),
    JSON.stringify(holder),
  );
  return holder;
}

test("cancel reports an already absent group as an unknown blocked outcome, not a sent signal", async () => {
  const directory = root();
  const holder = await abandoned(directory, "absent-cancel");
  const result = cancelAttempt(directory, holder.id);
  expect(result.kind).toBe("settled");
  if (result.kind !== "settled")
    throw new Error("Cancellation did not report the observed outcome");
  expect(result.attempt.outcome).toBe("unknown");
  expect(result.attempt.state).toBe("blocked");
  expect(readLease(directory, holder.resource).kind).toBe("blocked");
});

test("cancel reconciles a recorded exit before deciding whether to signal", async () => {
  const directory = root();
  const holder = await abandoned(directory, "recorded-cancel");
  writeFileSync(join(directory, "attempts", `${holder.id}.status`), "7\n");
  const result = cancelAttempt(directory, holder.id);
  expect(result.kind).toBe("settled");
  if (result.kind !== "settled") throw new Error("Recorded completion was not reconciled");
  expect(result.attempt.exitCode).toBe(7);
  expect(result.attempt.outcome).toBe("failed");
  expect(readLease(directory, holder.resource).kind).toBe("free");
});

test("repeated watches preserve a retained blocked outcome instead of inventing a new completion", async () => {
  const directory = root();
  const holder = await abandoned(directory, "blocked-watch");
  const first = watch(directory, holder.id);
  if (first.kind !== "settled") throw new Error("Unknown completion was not retained");
  const retained = { ...first.attempt, finishedAt: "2026-01-01T00:00:00.000Z" };
  writeFileSync(join(directory, "attempts", `${holder.id}.json`), JSON.stringify(retained));
  const next = watch(directory, holder.id);
  expect(next.kind).toBe("settled");
  if (next.kind !== "settled") throw new Error("Retained completion was lost");
  expect(next.attempt).toEqual(retained);
});

test("inspected release settles the lease while preserving an unknown outcome", async () => {
  const directory = root();
  const holder = await abandoned(directory, "inspected-release");
  watch(directory, holder.id);
  const result = resolveBlocked(directory, holder.id, { inspected: true });
  expect(result.state).toBe("settled");
  expect(result.outcome).toBe("unknown");
  expect(readLease(directory, holder.resource).kind).toBe("free");
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
