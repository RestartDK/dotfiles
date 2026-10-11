import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { host, type Command, type ProcessKey } from "./host.js";
import { setTimeout as delay } from "node:timers/promises";

export type { Command } from "./host.js";
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
async function release(token: string, key: ProcessKey): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const processes = await host().owned(token, key);
    if (!processes.length) return;
    for (const p of processes) {
      try {
        await host().signal(p, round < 10 ? "SIGTERM" : "SIGKILL");
      } catch {
        throw new Error("Owned process signal failed; cleanup remains pending");
      }
    }
    await delay(100);
  }
  if ((await host().owned(token, key)).length) throw new Error("Owned process release not verified");
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
