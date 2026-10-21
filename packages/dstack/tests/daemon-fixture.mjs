import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, startDaemon } from "../dist/server.js";

const root = process.env.DSTACK_FIXTURE_ROOT;
if (!root) throw new Error("Fixture root missing");
const fixture = fileURLToPath(new URL("./external.mjs", import.meta.url));
const runner = process.env.DSTACK_FIXTURE_RUNNER || process.execPath;
try {
  const daemon = await startDaemon({
    ...defaultConfig(),
    stateDir: join(root, "state"),
    socket: join(root, "state/jobs.sock"),
    worktreeRoot: join(root, "w"),
    configHome: join(root, "config"),
    remote: () => join(root, "remote"),
    pi: { file: runner, args: [fixture, "pi"] },
    gh: { file: runner, args: [fixture, "gh"] },
    observer: { file: runner, args: [fixture, "observer"] },
    intervalMs: 100,
    observationMs: 3000,
    workerMs: 10_000,
    maxRuns: 4,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  console.log("READY");
  const close = () => {
    void daemon.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
