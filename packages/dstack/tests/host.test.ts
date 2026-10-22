import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("owned file-only host binds retry payloads, reconciles receipts, bounds framing and releases on EOF", async () => {
  const child = spawn(
    process.env.DSTACK_TEST_NODE || "node",
    [fileURLToPath(new URL("../dist/tests/host-proof.js", import.meta.url))],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    console.log(output);
    expect(code).toBe(0);
    expect(output).toContain('"proof":"host"');
  } finally {
    clearTimeout(deadline);
  }
}, 50_000);
