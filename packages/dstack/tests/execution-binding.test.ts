import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("official SDK marker refuses implicit upgrade, missing identity and disabled managed reopen", () => {
  const proof = fileURLToPath(new URL("../dist/tests/execution-binding-proof.js", import.meta.url));
  const result = spawnSync(process.env.DSTACK_TEST_NODE ?? "node", [proof], { encoding: "utf8", timeout: 45000, maxBuffer: 128 * 1024 });
  if (result.status !== 0) throw new Error(`SDK binding proof failed: ${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  expect(result.stdout).toContain('"verdict":"sdk-execution-marker-component-only"');
}, 50000);
