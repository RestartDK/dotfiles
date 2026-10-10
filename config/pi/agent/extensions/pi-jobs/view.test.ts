import { expect, test } from "bun:test";
import { parseSnapshot, type Connection, type JobView } from "../../lib/dstack-jobs.ts";
import { modelContext, widgetLines } from "./view.ts";

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
  expect(widgetLines(connection)[0]).toContain("STALE");
  expect(widgetLines(connection).join("\n")).not.toContain("\u001b");
});
test("empty and connected-stale snapshots are distinct from fresh normal jobs", () => {
  const empty: Connection = {
    kind: "online",
    snapshot: { version: 1, now: 1, jobs: [] },
    receivedAt: 1,
  };
  expect(modelContext(empty, 2)).toBeNull();
  expect(widgetLines(empty, 2).join("\n")).toContain("No jobs");
  const normal: Connection = { ...empty, snapshot: { version: 1, now: 1, jobs: [job] } };
  expect(JSON.parse(modelContext(normal, 2) ?? "{}").stale).toBe(false);
  expect(JSON.parse(modelContext(normal, 20_000) ?? "{}").stale).toBe(true);
});
test("large job sets keep model-visible state while bounding passive widget height", () => {
  const jobs = Array.from({ length: 100 }, (_, i) => ({
    ...job,
    id: i.toString(16).padStart(24, "0"),
    pr: i + 1,
  }));
  const snapshot = parseSnapshot({ version: 1, now: 10, jobs });
  const connection: Connection = { kind: "online", snapshot, receivedAt: 10 };
  expect(widgetLines(connection, 11).length).toBeLessThanOrEqual(6);
  expect(JSON.parse(modelContext(connection, 11) ?? "{}").jobs).toHaveLength(100);
  expect(widgetLines(connection, 11).at(-1)).toContain("/jobs list");
});
