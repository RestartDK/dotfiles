import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync, type Stats } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ProcessResult =
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: string }
  | { kind: "timeout" | "cancelled" | "output-limit" }
  | { kind: "spawn-error"; message: string };
export type Execution = {
  result: ProcessResult;
  started: number;
  finished: number;
  stdout: string;
  stdoutHash: string;
  stderrHash: string;
};

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function executable(command: string, cwd: string): Promise<string> {
  const candidates =
    isAbsolute(command) || command.includes(sep)
      ? [resolve(cwd, command)]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .map((directory) => resolve(cwd, directory, command));
  for (const candidate of candidates) {
    try {
      const actual = await realpath(candidate);
      const stat = await lstat(actual);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return actual;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  throw new Error(`Executable not found: ${command}`);
}

export async function fingerprint(workspace: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  let files = 0;
  const visit = async (path: string): Promise<void> => {
    const absolute = resolve(workspace, path);
    const rel = relative(workspace, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("Outcome paths must stay inside the workspace");
    let stat: Stats;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      hash.update(JSON.stringify([path, "missing"]));
      return;
    }
    if (++files > 20000) throw new Error("Outcome scope exceeds 20000 entries");
    if (stat.isSymbolicLink() || (await realpath(absolute)) !== absolute)
      throw new Error(`Declare real paths, not symlinks: ${path}`);
    hash.update(JSON.stringify([path, stat.mode]));
    if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(join(path, name));
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 256 * 1024 * 1024) throw new Error("Outcome scope exceeds 256 MiB");
      hash.update(digest(await readFile(absolute)));
    } else throw new Error(`Unsupported outcome input: ${path}`);
  };
  for (const path of [...paths].sort()) await visit(path);
  return hash.digest("hex");
}

export async function runProcess(options: {
  command: readonly [string, ...string[]];
  cwd: string;
  timeoutMs: number;
  logPrefix: string;
  signal?: AbortSignal;
}): Promise<Execution> {
  const started = Date.now();
  const stdoutFd = openSync(`${options.logPrefix}.stdout`, "wx", 0o600);
  let stderrFd: number | undefined;
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  const stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let outputBytes = 0;
  try {
    const stderr = openSync(`${options.logPrefix}.stderr`, "wx", 0o600);
    stderrFd = stderr;
    const result = await new Promise<ProcessResult>((done, reject) => {
      const child = spawn(options.command[0], options.command.slice(1), {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      const finish = (completion: { result: ProcessResult } | { error: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        child.stdout.off("data", captureStdout);
        child.stderr.off("data", captureStderr);
        for (const stream of [child.stdout, child.stderr]) {
          if (stream.closed) stream.off("error", streamFailed);
          else stream.once("close", () => stream.off("error", streamFailed));
          stream.destroy();
        }
        try {
          if (child.pid !== undefined) {
            if (process.platform === "win32") child.kill("SIGKILL");
            else process.kill(-child.pid, "SIGKILL");
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            reject(error);
            return;
          }
        }
        if ("error" in completion) reject(completion.error);
        else done(completion.result);
      };
      const halt = (kind: "timeout" | "cancelled" | "output-limit") => finish({ result: { kind } });
      const abort = () => halt("cancelled");
      const capture = (data: Buffer, stream: "stdout" | "stderr") => {
        if (settled) return;
        try {
          outputBytes += data.length;
          if (outputBytes > 10 * 1024 * 1024) {
            halt("output-limit");
            return;
          }
          writeSync(stream === "stdout" ? stdoutFd : stderr, data);
          (stream === "stdout" ? stdoutHash : stderrHash).update(data);
          if (stream === "stdout") {
            stdoutBytes += data.length;
            if (stdoutBytes <= 65536) stdoutChunks.push(data);
          }
        } catch (error) {
          finish({ error });
        }
      };
      const captureStdout = (data: Buffer) => capture(data, "stdout");
      const captureStderr = (data: Buffer) => capture(data, "stderr");
      const streamFailed = (error: Error) => finish({ error });
      const spawnFailed = (error: Error) =>
        finish({ result: { kind: "spawn-error", message: error.message } });
      const closed = (code: number | null, signal: string | null) => {
        child.off("error", spawnFailed);
        finish({
          result: signal !== null ? { kind: "signal", signal } : { kind: "exit", code: code ?? -1 },
        });
      };
      const timer = setTimeout(() => halt("timeout"), options.timeoutMs);
      child.stdout.on("data", captureStdout);
      child.stderr.on("data", captureStderr);
      child.stdout.on("error", streamFailed);
      child.stderr.on("error", streamFailed);
      child.on("error", spawnFailed);
      child.once("close", closed);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
    return {
      result,
      started,
      finished: Date.now(),
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stdoutHash: stdoutHash.digest("hex"),
      stderrHash: stderrHash.digest("hex"),
    };
  } finally {
    try {
      closeSync(stdoutFd);
    } finally {
      if (stderrFd !== undefined) closeSync(stderrFd);
    }
  }
}
