import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, access } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { ShellReady, createPreparedShell, shellLaunchEnv, preparedCommand } from "./shell-ready.ts";

test("waits for acknowledgement rather than a startup delay", async () => {
  const ready = await ShellReady.create();
  try {
    let finished = false;
    const waiting = ready.wait(undefined, 2000).then(() => {
      finished = true;
    });
    await setTimeout(150);
    assert.equal(finished, false);
    await writeFile(ready.env.PI_HERDR_READY_FILE, "0\n");
    await waiting;
    assert.equal(finished, true);
  } finally {
    await ready.dispose();
  }
});

test("failed environment does not report a prepared shell", async () => {
  const ready = await ShellReady.create();
  try {
    await writeFile(ready.env.PI_HERDR_READY_FILE, "17\n");
    await assert.rejects(ready.wait(), /status 17/);
  } finally {
    await ready.dispose();
  }
});

test("missing integration times out and cancellation is supported", async () => {
  const ready = await ShellReady.create();
  try {
    await assert.rejects(ready.wait(undefined, 50), /timed out/);
    await assert.rejects(ready.wait(AbortSignal.abort()), /abort/i);
  } finally {
    await ready.dispose();
  }
});

test("concurrent launches cannot consume each other's acknowledgements", async () => {
  let first = "";
  let second = "";
  const launch = async (env: Record<string, string>) => {
    if (!first) first = env.PI_HERDR_READY_FILE;
    else second = env.PI_HERDR_READY_FILE;
    await writeFile(env.PI_HERDR_READY_FILE, "0\n");
    return env.PI_HERDR_READY_FILE;
  };
  await Promise.all([createPreparedShell({}, launch), createPreparedShell({}, launch)]);
  assert.notEqual(first, second);
  await assert.rejects(access(first));
  await assert.rejects(access(second));
});

test("namespace selection is part of all new shell launches", () => {
  assert.deepEqual(shellLaunchEnv({}), {});
  assert.equal(shellLaunchEnv({ PI_NETNS_SELECTED: "dev" }).PI_HERDR_ENTER_NETNS, "dev");
});

test("commands are guarded without replacing the interactive shell", () => {
  assert.equal(
    preparedCommand("cd src && cargo check"),
    "repo_env_prepare && { cd src && cargo check\n}",
  );
});
