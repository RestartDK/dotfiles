import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { HandoffLaunch, buildPiHandoffCommand } from "./worktree-launch.ts";
import { HandoffReadiness } from "./worktree-state.ts";

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "handoff-launch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const claimPath = join(directory, "claim");
  const launch = new HandoffLaunch(claimPath, "attempt");
  await launch.prepare();
  const command = buildPiHandoffCommand({
    launch,
    sessionFile: "fixture.jsonl",
    sessionName: undefined,
    successorId: "attempt",
    model: { provider: "fixture", id: "fixture" },
    thinking: "off",
    resourceArgs: [],
  });
  return { directory, claimPath, launch, command };
}

test("failed environment setup records its exit and stops before invoking Pi", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, ".envrc"), "");
  await assert.rejects(
    exec(
      "bash",
      [
        "-c",
        `direnv() { echo 'environment setup failed' >&2; return 37; }; pi() { echo must-not-start; }; export -f direnv pi; ${f.command}`,
      ],
      { cwd: f.directory },
    ),
    { code: 37 },
  );
  assert.deepEqual(await f.launch.read(), { kind: "exited", phase: "environment", code: 37 });
  assert.match(await readFile(f.launch.logPath, "utf8"), /environment setup failed/);
  await assert.rejects(
    new HandoffReadiness(f.claimPath, "attempt").wait(60_000, undefined, f.launch),
    /exited with status 37/,
  );
});

test("environment exports stay out of diagnostics and Pi exit status is retained", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, ".envrc"), "");
  await assert.rejects(
    exec(
      "bash",
      [
        "-c",
        `direnv() { if [ "$1" = export ]; then printf 'export HANDOFF_FIXTURE_SECRET=fixture-only-value\\n'; echo 'loader diagnostic' >&2; fi; }; pi() { test "$HANDOFF_FIXTURE_SECRET" = fixture-only-value && return 19; }; export -f direnv pi; ${f.command}`,
      ],
      { cwd: f.directory },
    ),
    { code: 19 },
  );
  assert.deepEqual(await f.launch.read(), { kind: "exited", phase: "pi", code: 19 });
  const log = await readFile(f.launch.logPath, "utf8");
  assert.match(log, /loader diagnostic/);
  assert.doesNotMatch(log, /fixture-only-value/);
});

test("invalid launch receipts fail closed rather than being treated as slow startup", async (t) => {
  const f = await fixture(t);
  for (const value of ["", "exited:pi:-1", "exited:pi:256", "exited:unknown:0", "unexpected"]) {
    await writeFile(f.launch.statusPath, value);
    await assert.rejects(f.launch.read(), /Invalid handoff launch status/);
  }
});
