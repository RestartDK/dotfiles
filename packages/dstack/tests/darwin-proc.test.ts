import { expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const proc = process.env.DSTACK_PROC || "dstack-proc";
const darwin = process.platform === "darwin";
const key = "DSTACK_PROCESS_TOKEN";

function run(args: string[]): Promise<string> {
  return exec(proc, args, { timeout: 10_000 }).then((result) => result.stdout);
}

async function alive(pid: number): Promise<boolean> {
  try {
    const { stdout } = await exec("ps", ["-o", "stat=", "-p", String(pid)]);
    return !stdout.trim().startsWith("Z");
  } catch {
    return false;
  }
}

async function until<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function owned(token: string): Promise<{ pid: number; start: string }[]> {
  return JSON.parse(await run(["owned", key, token])) as { pid: number; start: string }[];
}

test.skipIf(!darwin)(
  "owned lists a live token-bearing child, omits another token, and verify reads its own environment",
  async () => {
    const token = "a".repeat(48);
    const other = "b".repeat(48);
    const marked = spawn("/bin/sleep", ["60"], {
      stdio: "ignore",
      env: { ...process.env, [key]: token },
    });
    const unmarked = spawn("/bin/sleep", ["60"], { stdio: "ignore", env: { ...process.env } });
    try {
      const pid = marked.pid;
      const plain = unmarked.pid;
      if (pid === undefined || plain === undefined) throw new Error("Missing child pid");
      await until(
        async () => ((await owned(token)).some((entry) => entry.pid === pid) ? true : null),
        "the owned child",
      );
      expect((await owned(token)).map((entry) => entry.pid)).not.toContain(plain);
      expect((await owned(other)).map((entry) => entry.pid)).not.toContain(pid);
      expect(await owned(other)).toEqual([]);
      await run(["verify"]);
    } finally {
      marked.kill("SIGKILL");
      unmarked.kill("SIGKILL");
    }
  },
  30_000,
);

test.skipIf(!darwin)(
  "signal refuses a mismatched start time and token, then kills with the exact proof",
  async () => {
    const token = "c".repeat(48);
    const other = "d".repeat(48);
    const child = spawn("/bin/sleep", ["60"], {
      stdio: "ignore",
      env: { ...process.env, [key]: token },
    });
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error("Missing child pid");
      const identity = await until(
        async () => (await owned(token)).find((entry) => entry.pid === pid) ?? null,
        "the owned child",
      );
      await run(["signal", String(pid), "0.0", key, token, "SIGKILL"]);
      expect(await alive(pid)).toBe(true);
      await run(["signal", String(pid), identity.start, key, other, "SIGKILL"]);
      expect(await alive(pid)).toBe(true);
      await run(["signal", String(pid), identity.start, key, token, "SIGKILL"]);
      await until(async () => ((await alive(pid)) ? null : true), "the child to exit");
      expect(await owned(token)).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  },
  30_000,
);
