import { expect, test } from "bun:test";
import { parseSnapshot, type Connection, type JobView } from "../../lib/dstack-jobs.ts";
import { modelContext } from "./view.ts";
import { watchLine, type WatchView } from "../../lib/dstack-watches.ts";

const job: JobView = {
  id: "a".repeat(24),
  repo: "owner/repo",
  pr: 1,
  source: "/tmp/source",
  mode: "observe",
  createdAt: 1,
  updatedAt: 1,
  observedAt: 1,
  wakeAt: 90_000,
  head: null,
  verdict: null,
  state: { kind: "watching", reason: "review \u001b[2J\nwaiting" },
  runs: 0,
  maxRuns: 8,
  resources: [],
  pending: [],
  history: [],
};
test("offline retains jobs with an explicit stale signal and does not fabricate empty success", () => {
  const connection: Connection = {
    kind: "offline",
    reason: "unavailable",
    last: { version: 1, now: 1, jobs: [job] },
  };
  const content = modelContext(connection);
  if (!content) throw new Error("Lost cached job context");
  expect(JSON.parse(content)).toMatchObject({ stale: true, jobs: [{ id: job.id }] });
});
test("empty and connected-stale snapshots are distinct from fresh normal jobs", () => {
  const empty: Connection = {
    kind: "online",
    snapshot: { version: 1, now: 1, jobs: [] },
    receivedAt: 1,
  };
  expect(modelContext(empty, 2)).toBeNull();
  const normal: Connection = { ...empty, snapshot: { version: 1, now: 1, jobs: [job] } };
  expect(JSON.parse(modelContext(normal, 2) ?? "{}").stale).toBe(false);
  expect(JSON.parse(modelContext(normal, 20_000) ?? "{}").stale).toBe(true);
});
test("watch context is session-scoped, bounded and retains offline diagnostics", () => {
  const watch: WatchView = {
    id: "b".repeat(24),
    requestId: "tool",
    sessionId: "native",
    trigger: { kind: "timer", at: 1 },
    deadline: 2,
    message: "private reminder",
    createdAt: 0,
    updatedAt: 1,
    state: { kind: "error", reason: "unavailable\u001b[2J\n" + "x".repeat(2000) },
  };
  const watches = Array.from({ length: 100 }, (_, i) => ({
    ...watch,
    id: i.toString(16).padStart(24, "0"),
  }));
  const connection: Connection = {
    kind: "offline",
    reason: "unavailable",
    last: { version: 1, now: 10, jobs: [], watches },
  };
  expect(watchLine(watch)).not.toContain("\u001b");
  expect(watchLine(watch).length).toBeLessThanOrEqual(500);
  expect(modelContext(connection, 11, "different", "Receipt file unavailable")).toBeNull();
  const context = JSON.parse(
    modelContext(connection, 11, "native", "Receipt file unavailable") ?? "{}",
  );
  expect(context).toMatchObject({ stale: true, wakeReceiverStatus: "Receipt file unavailable" });
  expect(context.watches).toHaveLength(64);
});

test("large job sets keep every job visible to the model", () => {
  const jobs = Array.from({ length: 100 }, (_, i) => ({
    ...job,
    id: i.toString(16).padStart(24, "0"),
    pr: i + 1,
  }));
  const snapshot = parseSnapshot({ version: 1, now: 10, jobs });
  const connection: Connection = { kind: "online", snapshot, receivedAt: 10 };
  expect(JSON.parse(modelContext(connection, 11) ?? "{}").jobs).toHaveLength(100);
});
