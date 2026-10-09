import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { releaseProcess } from "../src/process.ts";

test("resource cleanup does not signal a borrowed process with another token", async () => {
  const borrowed = spawn(
    process.execPath,
    ["-e", 'console.log("READY");setInterval(()=>{},1000)'],
    {
      env: { ...process.env, DSTACK_PROCESS_TOKEN: randomBytes(24).toString("hex") },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      borrowed.once("error", reject);
      borrowed.stdout?.once("data", () => resolve());
    });
    await releaseProcess(randomBytes(24).toString("hex"));
    expect(borrowed.exitCode).toBeNull();
    expect(borrowed.signalCode).toBeNull();
  } finally {
    const closed = new Promise<void>((resolve) => borrowed.once("exit", () => resolve()));
    borrowed.kill("SIGTERM");
    await closed;
  }
});
