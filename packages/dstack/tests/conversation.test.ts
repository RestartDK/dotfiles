import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

async function runProof(
  kind: "integration" | "generation" | "unsafe-tool" | "close-failure" | "model-reopen",
): Promise<void> {
  const proof = fileURLToPath(new URL("../dist/tests/conversation-proof.js", import.meta.url));
  const node = process.env.DSTACK_TEST_NODE || "node";
  const child = spawn(node, [proof, kind], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    errors += chunk.toString("utf8");
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `Conversation ${kind} proof failed (${code}, ${signal})\n${output}\n${errors}`,
      ));
    });
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 35_000);
  try {
    await exited;
    const events: unknown[] = output
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line): unknown => JSON.parse(line));
    expect(events.some((event) =>
      typeof event === "object" && event !== null &&
      "event" in event && event.event === "pass" &&
      "proof" in event && event.proof === kind,
    )).toBe(true);
    console.log(output.trim());
  } finally {
    clearTimeout(deadline);
  }
}

test("CodingTools persist SQLite work and request deduplication under an immutable exclusive workspace", async () => {
  await runProof("integration");
}, 40_000);

test("SIGKILL after a committed request checkpoint recovers unfinished generation with the same provider identity", async () => {
  await runProof("generation");
}, 40_000);

test("SIGKILL after an unsafe CodingTools effect yields an interrupted result without replaying the effect", async () => {
  await runProof("unsafe-tool");
}, 40_000);

test("a SQLite checkpoint-close failure reports its error and releases workspace ownership", async () => {
  await runProof("close-failure");
}, 40_000);

test("reopen uses the stored model without requiring an obsolete initialization model", async () => {
  await runProof("model-reopen");
}, 40_000);
