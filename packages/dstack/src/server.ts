import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  parseRequest,
  socketPath,
  stateDirectory,
} from "../../../config/pi/agent/lib/dstack-jobs.js";
import { openController, type ControllerConfig } from "./controller.js";
import { acquireLock } from "./lock.js";
import type { Command } from "./process.js";

export type DaemonConfig = ControllerConfig & { socket: string; flock: Command };
export function defaultConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const stateDir = stateDirectory(env);
  return {
    stateDir,
    socket: socketPath(env),
    flock: { file: env.DSTACK_FLOCK || "flock", args: [] },
    worktreeRoot: env.DSTACK_WORKTREE_ROOT || join(homedir(), ".herdr/worktrees/dstack"),
    gh: { file: env.DSTACK_GH || "gh", args: [] },
    git: { file: env.DSTACK_GIT || "git", args: [] },
    pi: { file: env.DSTACK_PI || "pi", args: [] },
    observer: {
      file:
        env.DSTACK_OBSERVER ||
        join(homedir(), ".agents/skills/dstack/dstack-mode/scripts/watch-pr"),
      args: [],
    },
    env,
    configHome: env.XDG_CONFIG_HOME,
    remote: (repo) => `https://github.com/${repo}.git`,
    intervalMs: 60_000,
    observationMs: 30_000,
    workerMs: 600_000,
    maxRuns: 8,
  };
}
async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const error = (error: Error) => reject(error);
    server.once("error", error);
    server.listen(path, () => {
      server.off("error", error);
      resolve();
    });
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
export async function startDaemon(config: DaemonConfig) {
  if (process.platform !== "linux")
    throw new Error("This pilot requires Linux flock and /proc process identity");
  if (
    !isAbsolute(config.stateDir) ||
    !isAbsolute(config.socket) ||
    !isAbsolute(config.worktreeRoot)
  )
    throw new Error("Daemon paths must be absolute");
  process.umask(0o077);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(config.stateDir);
  const info = await lstat(config.stateDir);
  if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("State directory must be private and owned by this user");
  if (dirname(config.socket) !== stateDir || Buffer.byteLength(config.socket) > 100)
    throw new Error("Socket must fit inside the canonical private state directory");
  const unlock = await acquireLock(stateDir, config.flock);
  try {
    try {
      const existing = await lstat(config.socket);
      if (!existing.isSocket() || existing.uid !== process.getuid?.())
        throw new Error("Refusing to replace an unowned socket path");
      await unlink(config.socket);
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    const controller = await openController({ ...config, stateDir });
    let closing = false;
    const server = createServer(
      { requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 },
      async (req, res) => {
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        if (
          closing ||
          req.method !== "POST" ||
          req.url !== "/v1/jobs" ||
          req.headers["content-type"] !== "application/json"
        ) {
          res
            .writeHead(400)
            .end(JSON.stringify({ error: "Expected POST /v1/jobs with application/json" }));
          return;
        }
        try {
          let bytes = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            bytes += buffer.byteLength;
            if (bytes > 16_384) throw new Error("Request too large");
            chunks.push(buffer);
          }
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const result = await controller.request(parseRequest(body));
          res.end(JSON.stringify(result));
        } catch (error) {
          res
            .writeHead(400)
            .end(
              JSON.stringify({ error: error instanceof Error ? error.message : "Request failed" }),
            );
        }
      },
    );
    server.maxConnections = 128;
    try {
      await listen(server, config.socket);
      await chmod(config.socket, 0o600);
    } catch (error) {
      await controller.close();
      throw error;
    }
    let closingPromise: Promise<void> | null = null;
    return {
      socket: config.socket,
      close(): Promise<void> {
        closingPromise ??= (async () => {
          closing = true;
          await close(server);
          await controller.close();
          await unlock();
        })();
        return closingPromise;
      },
    };
  } catch (error) {
    await unlock();
    throw error;
  }
}
