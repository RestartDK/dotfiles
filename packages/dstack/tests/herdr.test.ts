import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { HerdrClient } from "../../../config/pi/agent/extensions/pi-herdr/client.ts";
import type {
  PaneInfo,
  ResponseResult,
} from "../../../config/pi/agent/extensions/pi-herdr/generated/success-response.ts";
import { record, type Connection, type JobView } from "../../../config/pi/agent/lib/dstack-jobs.ts";
import {
  herdrContext,
  jobsViewport,
  JobsPresentation,
  openJobsPane,
  watchJobsPane,
} from "../src/herdr.ts";

const owner = "a".repeat(32);
const directory = mkdtempSync("/tmp/dstack-pane-");
const socket = join(directory, "jobs.sock");
const socketHash = createHash("sha256").update(socket).digest("hex");
const pane: PaneInfo = {
  pane_id: "w1:p1",
  terminal_id: "term1",
  tab_id: "w1:t1",
  workspace_id: "w1",
  focused: true,
  agent_status: "unknown",
  revision: 1,
  cwd: "/tmp/source",
};
const owned: PaneInfo = {
  ...pane,
  pane_id: "w1:p2",
  terminal_id: "term2",
  tab_id: "w1:t2",
  tokens: { dstack_jobs_owner: owner, dstack_jobs_live: owner, dstack_jobs_socket: socketHash },
};
const created: ResponseResult = {
  type: "layout_apply",
  layout: {
    focused_pane_id: owned.pane_id,
    tab_id: owned.tab_id,
    workspace_id: owned.workspace_id,
    zoomed: false,
    root: { type: "pane", pane_id: owned.pane_id },
  },
};
const ready: ResponseResult = {
  type: "output_matched",
  pane_id: owned.pane_id,
  revision: 1,
  read: {
    format: "text",
    source: "visible",
    pane_id: owned.pane_id,
    tab_id: owned.tab_id,
    workspace_id: owned.workspace_id,
    revision: 1,
    truncated: false,
    text: "Dstack jobs |",
  },
};
type Method = Parameters<HerdrClient["call"]>[0];

function port(steps: [Method, ResponseResult][]) {
  const calls: { method: Method; params: unknown }[] = [];
  let launchedOwner: string | undefined;
  let launchedSocket: string | undefined;
  const herdr: Pick<HerdrClient, "call"> = {
    call: async (method, params) => {
      calls.push({ method, params });
      const next = steps.shift();
      if (!next) throw new Error(`Unexpected ${method}`);
      expect(method === next[0]).toBe(true);
      if (method === "layout.apply") {
        const env = record(record(record(params).root).env);
        if (typeof env.DSTACK_HERDR_OWNER === "string") launchedOwner = env.DSTACK_HERDR_OWNER;
        if (typeof env.DSTACK_SOCKET === "string") launchedSocket = env.DSTACK_SOCKET;
      }
      const result = next[1];
      if (
        result.type === "pane_info" &&
        result.pane.pane_id === owned.pane_id &&
        launchedOwner &&
        launchedSocket
      )
        return {
          ...result,
          pane: {
            ...result.pane,
            tokens: {
              dstack_jobs_owner: launchedOwner,
              dstack_jobs_live: launchedOwner,
              dstack_jobs_socket: createHash("sha256").update(launchedSocket).digest("hex"),
            },
          },
        };
      return result;
    },
  };
  return { herdr, calls };
}
const launch = {
  paneId: pane.pane_id,
  jobsSocket: socket,
  node: "/usr/bin/node",
  cli: "/opt/dstack/cli.js",
  notify: false,
};
const job: JobView = {
  id: "b".repeat(24),
  repo: "example/repo",
  pr: 1,
  source: "/tmp/source",
  mode: "observe",
  state: { kind: "watching", reason: "CI" },
  createdAt: 0,
  updatedAt: 1,
  observedAt: 1,
  wakeAt: 10,
  head: null,
  verdict: null,
  runs: 0,
  maxRuns: 4,
  resources: [],
  pending: [],
  history: [],
};
function online(now: number, jobs: JobView[] = [job]): Connection {
  return { kind: "online", snapshot: { version: 1, now, jobs }, receivedAt: now };
}

test("the hotkey focuses a live owned pane without starting another process", async () => {
  const { herdr, calls } = port([
    ["pane.get", { type: "pane_info", pane }],
    ["pane.list", { type: "pane_list", panes: [pane, owned] }],
    ["pane.get", { type: "pane_info", pane: owned }],
    ["pane.focus", { type: "pane_info", pane: owned }],
  ]);
  expect(await openJobsPane({ ...launch, herdr })).toEqual(owned);
  expect(
    calls.some((call) => call.method === "pane.send_input" || call.method === "tab.create"),
  ).toBe(false);
});

test("a label, expired lease, different daemon, or replaced terminal never authorizes pane reuse", async () => {
  const cases: { candidate: PaneInfo; refreshed?: PaneInfo }[] = [
    { candidate: { ...pane, label: "Jobs" } },
    {
      candidate: { ...owned, tokens: { dstack_jobs_owner: owner, dstack_jobs_socket: socketHash } },
    },
    { candidate: { ...owned, tokens: { ...owned.tokens, dstack_jobs_socket: "other" } } },
    { candidate: owned, refreshed: { ...owned, terminal_id: "replacement" } },
  ];
  for (const { candidate, refreshed } of cases) {
    const steps: [Method, ResponseResult][] = [
      ["pane.get", { type: "pane_info", pane }],
      ["pane.list", { type: "pane_list", panes: [candidate] }],
    ];
    if (refreshed) steps.push(["pane.get", { type: "pane_info", pane: refreshed }]);
    steps.push(
      ["layout.apply", created],
      ["pane.report_metadata", { type: "ok" }],
      ["pane.wait_for_output", ready],
      ["pane.get", { type: "pane_info", pane: owned }],
      ["pane.focus", { type: "pane_info", pane: owned }],
    );
    const { herdr, calls } = port(steps);
    await openJobsPane({ ...launch, herdr });
    expect(
      calls.filter((call) => call.method === "pane.send_input" || call.method === "tab.create"),
    ).toEqual([]);
    expect(
      record(record(calls.find((call) => call.method === "layout.apply")?.params).root).command,
    ).toEqual([launch.node, launch.cli, "herdr-view"]);
  }
});

test("paths and socket strings stay in environment data, never shell command text", async () => {
  const hostile = `${directory}/$(touch nope); "quotes"\nnext`;
  const { herdr, calls } = port([
    ["pane.get", { type: "pane_info", pane: { ...pane, foreground_cwd: hostile } }],
    ["pane.list", { type: "pane_list", panes: [] }],
    ["layout.apply", created],
    ["pane.report_metadata", { type: "ok" }],
    ["pane.wait_for_output", ready],
    ["pane.get", { type: "pane_info", pane: owned }],
    ["pane.focus", { type: "pane_info", pane: owned }],
  ]);
  await openJobsPane({ ...launch, herdr, cli: hostile, jobsSocket: hostile });
  const creation = record(calls.find((call) => call.method === "layout.apply")?.params);
  const root = record(creation.root);
  const env = record(root.env);
  const metadata = record(calls.find((call) => call.method === "pane.report_metadata")?.params);
  expect(root.cwd).toBe(hostile);
  expect(root.command).toEqual([launch.node, hostile, "herdr-view"]);
  expect(creation).not.toHaveProperty("tab_id");
  expect(env.DSTACK_SOCKET).toBe(hostile);
  expect(env.DSTACK_HERDR_OWNER).toMatch(/^[a-f0-9]{32}$/);
  expect(record(metadata.tokens).dstack_jobs_owner).toBe(env.DSTACK_HERDR_OWNER);
  expect(calls.some((call) => call.method === "pane.send_input")).toBe(false);
});

test("viewers reject missing ownership and calls outside Herdr before subscribing", async () => {
  expect(() => herdrContext({ HERDR_PANE_ID: "w1:p1" })).toThrow();
  const { herdr, calls } = port([["pane.get", { type: "pane_info", pane }]]);
  await expect(
    watchJobsPane({ herdr, paneId: pane.pane_id, env: { DSTACK_SOCKET: socket } }),
  ).rejects.toThrow("own marked Herdr pane");
  expect(calls.map((call) => call.method)).toEqual(["pane.get"]);
});

test("late snapshots and callbacks after disconnect cannot refresh presentation", () => {
  const view = new JobsPresentation({ ...owned, owner });
  const first = view.update(online(10));
  expect(
    view.update(online(9, [{ ...job, state: { kind: "blocked", reason: "old" } }])),
  ).toBeNull();
  const offline = view.update({
    kind: "offline",
    reason: "unavailable",
    last: { version: 1, now: 10, jobs: [job] },
  });
  expect(offline?.metadata.seq).toBe((first?.metadata.seq ?? 0) + 1);
  expect(offline?.metadata).toMatchObject({ source: `dstack-jobs:${owner}`, ttl_ms: 15000 });
  expect(offline?.metadata).not.toHaveProperty("agent");
  expect(offline?.text).toContain("cached state is stale");
  expect(offline?.text).toContain(job.id);
  view.close();
  expect(view.update(online(11))).toBeNull();
});

test("blocker and terminal transitions notify once, never on attach or an offline cache", () => {
  const view = new JobsPresentation({ ...owned, owner });
  const blocked = { ...job, state: { kind: "blocked", reason: "needs author" } } satisfies JobView;
  expect(view.update(online(1, [blocked]))?.notifications).toEqual([]);
  expect(view.update(online(2))?.notifications).toEqual([]);
  expect(view.update(online(3, [blocked]))?.notifications).toHaveLength(1);
  expect(view.update(online(4, [blocked]))?.notifications).toEqual([]);
  expect(
    view.update({
      kind: "offline",
      reason: "unavailable",
      last: { version: 1, now: 4, jobs: [blocked] },
    })?.notifications,
  ).toEqual([]);
  expect(
    view.update(
      online(5, [{ ...job, state: { kind: "terminal", reason: "merged", outcome: "merged" } }]),
    )?.notifications,
  ).toHaveLength(1);
});

test("job text cannot emit terminal control sequences and empty/offline views remain distinct", () => {
  const view = new JobsPresentation({ ...owned, owner });
  expect(view.update({ kind: "offline", reason: "unavailable", last: null })?.text).toContain(
    "No cached snapshot",
  );
  expect(view.update(online(1, []))?.text).toContain("No jobs registered");
  const text = view.update(
    online(2, [
      {
        ...job,
        source: "/tmp/\x1b]52;c;payload\x07",
        state: { kind: "blocked", reason: "\x1b[2J\x00王秀英" },
      },
    ]),
  )?.text;
  expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  expect(text).toContain("王秀英");
});

test("large and wide-character Jobs output preserves its header within the actual terminal viewport", () => {
  const text = ["Dstack jobs", ...Array.from({ length: 120 }, () => "王秀英".repeat(30))].join(
    "\n",
  );
  const shown = jobsViewport(text, 24, 5).split("\n");
  expect(shown).toHaveLength(4);
  expect(shown[0]).toBe("Dstack jobs");
  expect(shown.at(-1)).toContain("more lines");
  expect(shown[1]).toContain("…");
  expect(visibleWidth(shown[1] ?? "")).toBeLessThanOrEqual(24);
});
