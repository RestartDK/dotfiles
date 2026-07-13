import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fetchGitStatus,
  parseAheadBehindOutput,
  parseGitStatusOutput,
  parseLineDiffOutput,
} from "../git-status.ts";

test("parses Starship-compatible porcelain status categories", () => {
  const status = parseGitStatusOutput([
    "# branch.oid 0123456789abcdef",
    "# branch.head feature",
    "# branch.upstream origin/feature",
    "# branch.ab +4 -2",
    "1 .M N... 100644 100644 100644 abc abc modified.txt",
    "1 M. N... 100644 100644 100644 abc abc staged.txt",
    "1 A. N... 000000 100644 100644 abc abc added.txt",
    "1 D. N... 100644 000000 000000 abc abc deleted-index.txt",
    "1 .D N... 100644 100644 000000 abc abc deleted-worktree.txt",
    "1 .T N... 100644 100755 100755 abc abc typechanged.txt",
    "2 R. N... 100644 100644 100644 abc abc R100 renamed.txt\told.txt",
    "u UU N... 100644 100644 100644 100644 abc abc abc conflict.txt",
    "? untracked.txt",
  ].join("\n"));

  assert.deepEqual(status, {
    branch: "feature",
    upstream: "origin/feature",
    conflicted: 1,
    deleted: 2,
    renamed: 1,
    modified: 1,
    staged: 2,
    untracked: 1,
    typechanged: 1,
  });
});

test("parses parent-branch ahead and behind counts", () => {
  assert.deepEqual(parseAheadBehindOutput("3\t5"), { ahead: 5, behind: 3 });
  assert.equal(parseAheadBehindOutput("not-a-count"), null);
});

test("sums text line changes and ignores binary numstat entries", () => {
  assert.deepEqual(parseLineDiffOutput([
    "10\t2\tfirst.ts",
    "3\t7\tsecond.ts",
    "-\t-\timage.png",
  ].join("\n")), {
    linesAdded: 13,
    linesRemoved: 9,
  });
});

test("compares commits and working tree lines with the parent branch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-prompt-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

  try {
    git("init", "-b", "main");
    writeFileSync(join(cwd, "tracked.txt"), "one\ntwo\n");
    git("add", "tracked.txt");
    git("-c", "user.name=Pi Prompt", "-c", "user.email=pi-prompt@example.test", "commit", "-m", "base");
    git("switch", "-c", "feature");
    writeFileSync(join(cwd, "tracked.txt"), "one\nchanged\nthree\n");
    git("add", "tracked.txt");
    git("-c", "user.name=Pi Prompt", "-c", "user.email=pi-prompt@example.test", "commit", "-m", "feature");
    writeFileSync(join(cwd, "tracked.txt"), "one\nchanged\nthree\nfour\n");
    writeFileSync(join(cwd, "untracked.txt"), "ignored by line metrics\n");

    const status = await fetchGitStatus(cwd);

    assert.ok(status);
    assert.equal(status.branch, "feature");
    assert.equal(status.parentBranch, "main");
    assert.equal(status.ahead, 1);
    assert.equal(status.behind, 0);
    assert.equal(status.modified, 1);
    assert.equal(status.untracked, 1);
    assert.equal(status.linesAdded, 3);
    assert.equal(status.linesRemoved, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
