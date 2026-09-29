import assert from "node:assert/strict";
import test from "node:test";

import { buildPiHandoffCommand, worktreeBranchFromArg } from "./worktree-handoff.ts";

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
  assert.ok(command.includes("--fork '/home/daniel/.pi/agent/sessions/--home-daniel-cobb--/a.jsonl'"));
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
