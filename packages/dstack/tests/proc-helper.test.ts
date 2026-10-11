import { expect, test } from "bun:test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const helper = process.env.DSTACK_PROC ?? "";
const enabled = helper.length > 0;

type Owned = { pid: number; start: string };

function run(args: string[]): Promise<string> {
  if (!helper) throw new Error("DSTACK_PROC is not set");
  return exec(helper, args, { timeout: 30_000 }).then((result) => result.stdout);
}

async function owned(token: string): Promise<Owned[]> {
  return JSON.parse(await run(["owned", "DSTACK_PROCESS_TOKEN", token])) as Owned[];
}

async function found(token: string): Promise<Owned> {
  return until(async () => (await owned(token))[0] ?? null, "the child to become owned");
}

async function until<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** A zombie is not alive. `kill(pid, 0)` succeeds against one, so read the state on Linux. */
async function alive(pid: number): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function worker(value: string): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    stdio: "ignore",
    env: { ...process.env, DSTACK_PROCESS_TOKEN: value },
  });
}

test.skipIf(!enabled)(
  "owned lists a live token-bearing child, omits another token, and verify names this user",
  async () => {
    const mine = randomBytes(24).toString("hex");
    const theirs = randomBytes(24).toString("hex");
    const child = worker(mine);
    try {
      const pid = child.pid;
      if (pid === undefined) throw new Error("missing worker pid");
      const listed = await found(mine);
      expect(listed.pid).toBe(pid);
      expect(listed.start).toMatch(/^\d+\.\d{6}$/);
      expect(await owned(theirs)).toEqual([]);
      expect(JSON.parse(await run(["verify"])).uid).toBe(process.getuid?.());
    } finally {
      child.kill("SIGKILL");
    }
  },
  60_000,
);

test.skipIf(!enabled)(
  "signal refuses a bogus start, another process's start and a wrong token, then kills with the exact proof",
  async () => {
    const mine = randomBytes(24).toString("hex");
    const theirs = randomBytes(24).toString("hex");
    const other = worker(theirs);
    let target: ChildProcess | null = null;
    try {
      const otherPid = other.pid;
      if (otherPid === undefined) throw new Error("missing worker pid");
      const theirsStarted = await found(theirs);
      await new Promise((resolve) => setTimeout(resolve, 50));
      target = worker(mine);
      const pid = target.pid;
      if (pid === undefined) throw new Error("missing worker pid");
      const mineStarted = await found(mine);
      expect(mineStarted.start).not.toBe(theirsStarted.start);

      await run(["signal", String(pid), "1.000000", "DSTACK_PROCESS_TOKEN", mine, "SIGKILL"]);
      expect(await alive(pid)).toBe(true);

      await run([
        "signal",
        String(pid),
        theirsStarted.start,
        "DSTACK_PROCESS_TOKEN",
        mine,
        "SIGKILL",
      ]);
      expect(await alive(pid)).toBe(true);

      await run([
        "signal",
        String(pid),
        mineStarted.start,
        "DSTACK_PROCESS_TOKEN",
        theirs,
        "SIGKILL",
      ]);
      expect(await alive(pid)).toBe(true);

      await run([
        "signal",
        String(pid),
        mineStarted.start,
        "DSTACK_PROCESS_TOKEN",
        mine,
        "SIGKILL",
      ]);
      await until(async () => ((await alive(pid)) ? null : true), "the target to exit");
      expect(await owned(mine)).toEqual([]);
    } finally {
      target?.kill("SIGKILL");
      other.kill("SIGKILL");
    }
  },
  60_000,
);
