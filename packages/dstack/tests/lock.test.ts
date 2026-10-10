import { gc } from "bun";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../src/lock.ts";

test("a held lock survives collection of the acquisition subprocess and releases explicitly", async () => {
  const directory = mkdtempSync("/tmp/dstack-lock-");
  const flock = process.env.DSTACK_FLOCK || "flock";
  const contend = () =>
    spawnSync(flock, ["--nonblock", join(directory, "daemon.lock"), "true"], {
      stdio: "ignore",
    }).status;
  for (let iteration = 0; iteration < 4; iteration++) {
    const unlock = await acquireLock(directory, { file: flock, args: [] });
    try {
      expect(contend()).toBe(1);
      gc(true);
      expect(contend()).toBe(1);
    } finally {
      await unlock();
    }
    expect(contend()).toBe(0);
  }
});
