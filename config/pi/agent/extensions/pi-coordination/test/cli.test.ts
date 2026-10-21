import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Attempt } from "../core.ts";

const roots: string[] = [];
const cli = join(dirname(fileURLToPath(import.meta.url)), "../cli.ts");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const cases = [
  { state: "settled", outcome: "unknown", exitCode: undefined, expected: 1 },
  { state: "settled", outcome: "failed", exitCode: 7, expected: 7 },
  { state: "settled", outcome: "completed", exitCode: 0, expected: 0 },
  { state: "blocked", outcome: "completed", exitCode: 0, expected: 75 },
] satisfies Array<Pick<Attempt, "state" | "outcome" | "exitCode"> & { expected: number }>;

for (const fixture of cases) {
  test(`retry and watch preserve ${fixture.state}/${fixture.outcome} instead of reporting false success`, () => {
    const root = mkdtempSync(join(tmpdir(), "coord-cli-"));
    roots.push(root);
    mkdirSync(join(root, "attempts"));
    const attempt: Attempt = {
      version: 1,
      id: "retained",
      resource: "fixture:cli",
      owner: "fixture-owner",
      label: "fixture",
      revision: "fixture",
      cwd: root,
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:01Z",
      state: fixture.state,
      outcome: fixture.outcome,
      exitCode: fixture.exitCode,
    };
    writeFileSync(join(root, "attempts/retained.json"), JSON.stringify(attempt));
    for (const args of [
      [
        "exec",
        "--id",
        attempt.id,
        "--resource",
        attempt.resource,
        "--",
        "printf",
        "DO_NOT_EXECUTE",
      ],
      ["watch", "--id", attempt.id],
    ]) {
      const result = spawnSync(process.execPath, [cli, "--dir", root, ...args], {
        encoding: "utf8",
      });
      if (result.error) throw result.error;
      expect(result.status).toBe(fixture.expected);
      expect(result.stdout).toContain(fixture.outcome);
      expect(result.stdout).not.toContain("DO_NOT_EXECUTE");
      expect(result.stderr).toBe("");
    }
  });
}
