import assert from "node:assert/strict";
import test from "node:test";
import { observePaneForeground, parseProcStat, type ProcProcess } from "./pane-foreground.ts";

const info = { pane_id: "wrapped", shell_pid: 10, foreground_process_group_id: 10 };
const wrapper: ProcProcess = {
  pid: 10,
  parentPid: 1,
  groupId: 10,
  tty: 1,
  foregroundGroupId: 10,
  shell: "other",
};
const nested: ProcProcess = {
  pid: 20,
  parentPid: 10,
  groupId: 20,
  tty: 2,
  foregroundGroupId: 20,
  shell: "interactive",
};

test("wrapped idle shells are accepted but their actual foreground jobs reject launch", async () => {
  for (const [records, expected] of [
    [[wrapper, nested], "idle"],
    [
      [
        wrapper,
        { ...nested, foregroundGroupId: 30 },
        {
          ...nested,
          pid: 30,
          parentPid: 20,
          groupId: 30,
          foregroundGroupId: 30,
          shell: "other",
        },
      ],
      "busy",
    ],
    [
      [
        wrapper,
        nested,
        {
          ...nested,
          pid: 30,
          parentPid: 20,
          groupId: 30,
          foregroundGroupId: 30,
          tty: 3,
          shell: "other",
        },
      ],
      "busy",
    ],
    [[{ ...wrapper, shell: "interactive" }], "idle"],
    [[wrapper, nested, { ...nested, pid: 30, parentPid: 20, groupId: 30 }], "idle"],
    [[wrapper, { ...nested, groupId: 10, foregroundGroupId: 10, tty: 1 }], "initializing"],
    [[wrapper], "initializing"],
    [[], "initializing"],
  ] satisfies [ProcProcess[], string][]) {
    assert.equal(
      (await observePaneForeground(info, { platform: "linux", readTree: async () => records }))
        .kind,
      expected,
    );
  }
});

test("nullable process data waits, non-Linux shell behavior stays valid, and access errors are not ignored", async () => {
  assert.equal((await observePaneForeground({ pane_id: "new" })).kind, "initializing");
  assert.equal((await observePaneForeground(info, { platform: "darwin" })).kind, "idle");
  assert.equal(
    (
      await observePaneForeground(
        { ...info, foreground_process_group_id: 30 },
        { platform: "darwin" },
      )
    ).kind,
    "busy",
  );
  await assert.rejects(
    observePaneForeground(info, {
      platform: "linux",
      readTree: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    }),
    { code: "EACCES" },
  );
});

test("Linux stat parsing handles process names with spaces and parentheses and rejects malformed records", () => {
  const fields = ["S", "10", "20", "10", "34816", "30", ...Array(20).fill("0")];
  const stat = `20 (a shell (name)) ${fields.join(" ")}`;
  assert.deepEqual(parseProcStat(stat), {
    pid: 20,
    name: "a shell (name)",
    parentPid: 10,
    groupId: 20,
    tty: 34816,
    foregroundGroupId: 30,
  });
  assert.throws(() => parseProcStat("20 (broken) S 10"), /Invalid/);
  assert.throws(() => parseProcStat(stat.replace("34816", "unknown")), /Invalid/);
});
