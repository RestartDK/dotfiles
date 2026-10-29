import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("client roots load authority before SDK, protect credentials and refuse omitted policy", () => {
  const proof = fileURLToPath(new URL("../dist/tests/client-host-proof.js", import.meta.url));
  const result = spawnSync(process.env.DSTACK_TEST_NODE ?? "node", [proof], { encoding: "utf8", timeout: 30000, maxBuffer: 128 * 1024 });
  if (result.status !== 0) throw new Error(`Client host proof failed: ${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`);
  expect(result.stdout).toContain('"proof":"client-authority-host-component"');
  expect(result.stdout).toContain('"bindingVersion":3');
}, 35000);
