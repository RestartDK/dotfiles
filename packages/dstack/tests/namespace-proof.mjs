import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = await mkdtemp("/tmp/dns-");
const daemon = fileURLToPath(new URL("../dist/daemon.js", import.meta.url));
const env = {
  ...process.env,
  DSTACK_STATE_DIR: join(root, "state"),
  DSTACK_SOCKET: join(root, "state/jobs.sock"),
  DSTACK_WORKTREE_ROOT: join(root, "w"),
};
const child = spawn(process.execPath, [daemon], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Daemon readiness deadline: ${output}`)),
      15_000,
    );
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("dstackd ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Daemon exited ${code}: ${output}`));
    });
  });
  const original = await readlink(`/proc/${child.pid}/ns/net`);
  const script = `import { readlink } from 'node:fs/promises'; console.log(await readlink('/proc/self/ns/net')); await import(${JSON.stringify(new URL("../dist/daemon.js", import.meta.url).href)});`;
  let duplicate;
  try {
    await exec(
      "unshare",
      [
        "--user",
        "--map-current-user",
        "--net",
        "--kill-child",
        process.execPath,
        "--input-type=module",
        "--eval",
        script,
      ],
      { env, timeout: 15_000 },
    );
  } catch (error) {
    duplicate = error;
  }
  assert.ok(duplicate instanceof Error && "stdout" in duplicate && "stderr" in duplicate);
  assert.notEqual(duplicate.stdout.trim(), original);
  assert.match(duplicate.stderr, /Another daemon owns this state directory/);
  assert.equal(child.exitCode, null);
  console.log(
    JSON.stringify({
      root,
      originalNamespace: original,
      competingNamespace: duplicate.stdout.trim(),
      duplicateRefused: true,
      originalStillRunning: true,
    }),
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Owned proof daemon shutdown deadline"));
      }, 15_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    child.kill("SIGTERM");
    await exited;
  }
}
