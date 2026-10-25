import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("paired execution journal preserves order and refuses partial loss, rollback and orphaned records", () => {
  const proof = fileURLToPath(new URL("../dist/tests/execution-proof.js", import.meta.url));
  const result = spawnSync(process.env.DSTACK_TEST_NODE || "node", [proof], {
    encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(`Execution proof failed (${result.status}, ${result.signal})\n${result.stdout}\n${result.stderr}`);
  const events: unknown[] = result.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  expect(events.some(value => typeof value === "object" && value !== null && "event" in value && value.event === "pass" && "proof" in value && value.proof === "execution-journal")).toBe(true);
  console.log(result.stdout.trim());
}, 20_000);
