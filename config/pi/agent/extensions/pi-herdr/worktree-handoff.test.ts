import assert from "node:assert/strict";
import test from "node:test";

import type { HerdrClient } from "./client.ts";
import type { WorktreeWorkspace } from "./worktree.ts";
import { buildPiHandoffCommand, handoffPane, worktreeBranchFromArg } from "./worktree-handoff.ts";

const checkout: WorktreeWorkspace = {
  workspace: {
    workspace_id: "w1",
    active_tab_id: "w1:t1",
    agent_status: "unknown",
    focused: false,
    label: "task",
    number: 1,
    pane_count: 1,
    tab_count: 1,
  },
  tab: {
    workspace_id: "w1",
    tab_id: "w1:t1",
    agent_status: "unknown",
    focused: false,
    label: "task",
    number: 1,
    pane_count: 1,
  },
  root_pane: {
    workspace_id: "w1",
    tab_id: "w1:t1",
    pane_id: "w1:p1",
    terminal_id: "terminal",
    agent_status: "unknown",
    focused: false,
    revision: 0,
  },
  worktree: { path: "/tmp/checkout", branch: "daniel/task" },
  already_open: true,
};

test("handoff never sends a launch command into an existing agent or source pane", async () => {
  for (const pane of [
    { ...checkout.root_pane, agent: "pi" },
    { ...checkout.root_pane, pane_id: "source" },
  ]) {
    const client: Pick<HerdrClient, "call"> = {
      async call(method) {
        assert.equal(method, "pane.list");
        return { type: "pane_list", panes: [pane] };
      },
    };
    await assert.rejects(handoffPane(client, checkout, "source"), /already has an agent/);
  }
});

test("reused idle workspaces get a fresh successor shell", async () => {
  const fresh = { ...checkout.root_pane, pane_id: "w1:p2", tab_id: "w1:t2" };
  const methods: string[] = [];
  const client: Pick<HerdrClient, "call"> = {
    async call(method, params) {
      methods.push(method);
      if (method === "pane.list") return { type: "pane_list", panes: [checkout.root_pane] };
      assert.equal(method, "tab.create");
      assert.deepEqual(params, {
        workspace_id: "w1",
        cwd: "/tmp/checkout",
        label: "Pi",
        focus: false,
      });
      return { type: "tab_created", tab: { ...checkout.tab, tab_id: "w1:t2" }, root_pane: fresh };
    },
  };
  assert.equal((await handoffPane(client, checkout, "source")).pane_id, "w1:p2");
  assert.deepEqual(methods, ["pane.list", "tab.create"]);
});

test("new workspaces already provide an owned successor shell", async () => {
  const client: Pick<HerdrClient, "call"> = {
    async call() {
      throw new Error("No additional terminal is needed.");
    },
  };
  assert.equal(
    await handoffPane(client, { ...checkout, already_open: false }, "source"),
    checkout.root_pane,
  );
});

test("bare names get the daniel/ prefix", () => {
  assert.equal(worktreeBranchFromArg("twi-7441"), "daniel/twi-7441");
  assert.equal(worktreeBranchFromArg("  twi-7441  "), "daniel/twi-7441");
});

test("explicit namespaced branches pass through", () => {
  assert.equal(worktreeBranchFromArg("daniel/twi-7441"), "daniel/twi-7441");
  assert.equal(worktreeBranchFromArg("feature/custom"), "feature/custom");
});

test("handoff command forks the session and carries the close-tab marker", () => {
  const command = buildPiHandoffCommand({
    sessionFile: "/home/daniel/.pi/agent/sessions/--home-daniel-cobb--/a.jsonl",
    sessionName: "Move Pi Session",
    closeTabId: "w5Q:t7J",
  });
  assert.ok(command.includes("direnv allow ."));
  assert.ok(command.includes("PI_HERDR_CLOSE_TAB='w5Q:t7J'"));
  assert.ok(
    command.includes("--fork '/home/daniel/.pi/agent/sessions/--home-daniel-cobb--/a.jsonl'"),
  );
  assert.ok(command.includes("--name 'Move Pi Session'"));
});

test("handoff command omits --name when the session is unnamed", () => {
  const command = buildPiHandoffCommand({
    sessionFile: "/tmp/a.jsonl",
    sessionName: undefined,
    closeTabId: "w1:t1",
  });
  assert.ok(!command.includes("--name"));
  assert.ok(!command.includes("undefined"));
});

test("handoff command quotes apostrophes safely", () => {
  const command = buildPiHandoffCommand({
    sessionFile: "/tmp/it's.jsonl",
    sessionName: "daniel's task",
    closeTabId: "w1:t1",
  });
  assert.ok(command.includes(`--fork '/tmp/it'\\''s.jsonl'`));
  assert.ok(command.includes(`--name 'daniel'\\''s task'`));
});
