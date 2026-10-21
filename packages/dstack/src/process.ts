import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { array, number, record, string } from "../../../config/pi/agent/lib/dstack-jobs.js";
import { setTimeout as delay } from "node:timers/promises";

export type Command = { file: string; args: string[] };
export type ProcessOptions = {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  input?: string;
  token?: string;
  scope?: string;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
};
export class ProcessFailure extends Error {
  constructor(
    readonly category: "exit" | "deadline" | "cancelled" | "output" | "start",
    readonly code: number | null = null,
  ) {
    super(`External process ${category}${code === null ? "" : ` (${code})`}`);
  }
}
type Identity = { pid: number; start: string; token: string };
const exec = promisify(execFile);
const processScan = `import json, os, sys
wanted, key = sys.argv[1:]
result = []
for pid in os.listdir('/proc'):
    if not pid.isdecimal():
        continue
    path = '/proc/' + pid
    try:
        if os.stat(path).st_uid != os.getuid():
            continue
        with open(path + '/environ', 'rb') as f:
            env = f.read().split(b'\\0')
        if (key + '=' + wanted).encode() not in env:
            continue
        with open(path + '/stat') as f:
            fields = f.read().rsplit(')', 1)[1].split()
        if fields[0] != 'Z':
            result.append({'pid':int(pid), 'start':fields[19]})
    except (ProcessLookupError, FileNotFoundError, PermissionError):
        continue
print(json.dumps(result))
`;
async function owned(token: string, key: string): Promise<Identity[]> {
  const output = await exec(
    process.env.DSTACK_PYTHON || "python3",
    ["-c", processScan, token, key],
    { timeout: 3000, maxBuffer: 128 * 1024 },
  );
  const parsed: unknown = JSON.parse(output.stdout);
  return array(parsed).map((raw) => {
    const value = record(raw);
    return { pid: number(value.pid), start: string(value.start), token };
  });
}
const pidfdSignal = `import os, signal, sys
pid, started, token, key, action = sys.argv[1:]
try:
    fd = os.pidfd_open(int(pid))
    try:
        path = '/proc/' + pid
        with open(path + '/stat') as f:
            actual = f.read().rsplit(')', 1)[1].split()[19]
        with open(path + '/environ', 'rb') as f:
            env = f.read().split(b'\\0')
        if actual == started and (key + '=' + token).encode() in env and os.stat(path).st_uid == os.getuid():
            signal.pidfd_send_signal(fd, getattr(signal, action))
    finally:
        os.close(fd)
except (ProcessLookupError, FileNotFoundError):
    pass
`;
async function release(token: string, key: string): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const processes = await owned(token, key);
    if (!processes.length) return;
    for (const p of processes) {
      try {
        await exec(
          process.env.DSTACK_PYTHON || "python3",
          [
            "-c",
            pidfdSignal,
            String(p.pid),
            p.start,
            token,
            key,
            round < 10 ? "SIGTERM" : "SIGKILL",
          ],
          { timeout: 3000, maxBuffer: 1024 },
        );
      } catch {
        throw new Error("Owned process pidfd signal failed; cleanup remains pending");
      }
    }
    await delay(100);
  }
  if ((await owned(token, key)).length) throw new Error("Owned process release not verified");
}
export function releaseProcess(token: string): Promise<void> {
  return release(token, "DSTACK_PROCESS_TOKEN");
}
export function releaseScope(token: string): Promise<void> {
  return release(token, "DSTACK_PROCESS_SCOPE");
}
export async function run(
  command: Command,
  args: string[],
  options: ProcessOptions,
): Promise<string> {
  options.signal.throwIfAborted();
  const token = options.token ?? randomBytes(24).toString("hex");
  let failure: ProcessFailure | null = null;
  let output = "";
  let bytes = 0;
  let releasing: Promise<void> | null = null;
  const releaseOwned = () => (releasing ??= releaseProcess(token));
  const interrupted = Promise.withResolvers<never>();
  const child = spawn(command.file, [...command.args, ...args], {
    cwd: options.cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...options.env,
      DSTACK_PROCESS_TOKEN: token,
      ...(options.scope ? { DSTACK_PROCESS_SCOPE: options.scope } : {}),
    },
  });
  const stop = (reason: ProcessFailure) => {
    failure ??= reason;
    child.kill("SIGKILL");
    void releaseOwned().then(
      () => interrupted.reject(reason),
      (error: unknown) => interrupted.reject(error),
    );
  };
  const abort = () => stop(new ProcessFailure("cancelled"));
  options.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(new ProcessFailure("deadline")), options.timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > (options.maxBytes ?? 2 * 1024 * 1024)) stop(new ProcessFailure("output"));
    else output += chunk;
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let code: number | null = null;
  try {
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on("error", () => reject(new ProcessFailure("start")));
      child.on("exit", resolve);
    }).then(async (value) => {
      if (value !== 0) await releaseOwned();
      await closed;
      return value;
    });
    code = await Promise.race([exited, interrupted.promise]);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    if (!options.scope || options.token || failure || code !== 0) await releaseOwned();
  }
  if (failure) throw failure;
  if (code !== 0) throw new ProcessFailure("exit", code);
  return output;
}
