import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("host catalogue pairs root identity and admission without upgrading legacy or replaying orphans", () => {
  const proof = fileURLToPath(new URL("../dist/tests/execution-catalogue-proof.js", import.meta.url));
  const result = spawnSync(process.env.DSTACK_TEST_NODE ?? "node", [proof], { encoding: "utf8", timeout: 45000, maxBuffer: 128 * 1024 });
  if (result.status !== 0) throw new Error(`Catalogue proof failed: ${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  expect(result.stdout).toContain('"verdict":"paired-host-catalogue-component-only"');
}, 50000);
