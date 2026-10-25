import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

function nativeProof(name: "execution-files-proof" | "execution-files-recovery"): string {
  const result = spawnSync(process.env.DSTACK_TEST_NODE || "node", [fileURLToPath(new URL(`../dist/tests/${name}.js`, import.meta.url))], { encoding: "utf8", timeout: 45_000, maxBuffer: 128 * 1024 });
  if (result.status !== 0) throw new Error(`Native SDK file wrapper proof failed: ${result.stdout}\n${result.stderr}`, { cause: result.error });
  return result.stdout;
}

test("official SDK file wrappers bind writes, protect state and reject unresolved effects", () => {
  expect(nativeProof("execution-files-proof")).toContain('"verdict":"actual-sdk-file-wrapper-component-only"');
}, 50_000);

test("SDK execute-phase recovery bypasses beforeTool but cannot bypass the actual file wrapper", () => {
  expect(nativeProof("execution-files-recovery")).toContain('"verdict":"actual-sdk-recovery-wrapper-component-only"');
}, 50_000);
