import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = process.env.DSTACK_WAKE_FIXTURE;
if (!root) throw new Error("Missing isolated wake fixture");
if (process.argv[2] === "gh") {
  const data = JSON.parse(await readFile(join(root, "github.json"), "utf8"));
  if (data.recordOwnership) {
    const file = join(root, "gh-process.json");
    const ownership = JSON.stringify({
      pid: process.pid,
      token: process.env.DSTACK_PROCESS_TOKEN,
      scope: process.env.DSTACK_PROCESS_SCOPE,
    });
    await writeFile(`${file}.tmp`, ownership);
    await rename(`${file}.tmp`, file);
    await new Promise((resolve, reject) => {
      const connection = createConnection(join(root, "admission-ready.sock"));
      connection.once("error", reject);
      connection.once("connect", () => connection.end(ownership, resolve));
    });
  }
  if (data.delay) await setTimeout(data.delay);
  if (data.unavailable) process.exitCode = 1;
  else process.stdout.write(JSON.stringify(data.response));
} else if (process.argv[2] === "legacy") {
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { createRegistry, defineDoc, Harness } = await import("@earendil-works/pi-durable");
  const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
  const job = JSON.parse(await readFile(join(root, "legacy-job.json"), "utf8"));
  await mkdir(join(root, "state"), { mode: 0o700 });
  const jobs = defineDoc({
    kind: "dstack.jobs",
    version: 1,
    scope: "session",
    initial: () => ({ jobs: {} }),
  });
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(root, "state/jobs.sqlite")),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  await harness.commit(async (tx) => {
    (await tx.doc(jobs)).jobs[job.view.id] = job;
  }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
} else {
  const { defaultConfig, startDaemon } = await import("../dist/server.js");
  const daemon = await startDaemon({
    ...defaultConfig(),
    stateDir: join(root, "state"),
    socket: join(root, "state/jobs.sock"),
    worktreeRoot: join(root, "worktrees"),
    gh: { file: process.execPath, args: [fileURLToPath(import.meta.url), "gh"] },
    intervalMs: 80,
    observationMs: 5000,
  });
  process.send?.({ kind: "ready" });
  const close = () => {
    void daemon.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
