import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("trusted command grants retain FDs and expire instead of reconstructing authority", () => {
  const proof = fileURLToPath(new URL("../dist/tests/execution-commands-proof.js", import.meta.url));
  const result = spawnSync(process.env.DSTACK_TEST_NODE ?? "node", [proof], { encoding: "utf8", timeout: 45000, maxBuffer: 128 * 1024 });
  if (result.status !== 0) throw new Error(`Native command grant proof failed: ${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  expect(result.stdout).toContain('"verdict":"trusted-command-grant-component-only"');
}, 50000);
