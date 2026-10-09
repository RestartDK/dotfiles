import { existsSync, renameSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, Harness } from "@earendil-works/pi-durable";

const root = process.env.DSTACK_FIXTURE_ROOT;
const jobs = defineDoc({
  kind: "dstack.jobs",
  version: 1,
  scope: "session",
  initial: () => ({ jobs: {} }),
});
const open = Harness.open;
Harness.open = async (...args) => {
  const harness = await open(...args);
  if (root && existsSync(join(root, "terminal-fault-consumed"))) {
    let captured = false;
    const capture = async () => {
      if (captured) return;
      const database = new DatabaseSync(join(root, "state/jobs.sqlite"), { readOnly: true });
      const tasks = database.prepare("SELECT kind, status FROM tasks").all();
      database.close();
      if (!tasks.length || tasks.some((task) => task.status !== "terminal")) return;
      captured = true;
      const store = await harness.snapshot(jobs, BACKGROUND_CONTEXT);
      writeFileSync(
        join(root, "recovered-task-completion.next"),
        JSON.stringify({
          tasks,
          states: Object.values(store?.jobs ?? {}).map((job) => job.view.state),
        }),
      );
      renameSync(
        join(root, "recovered-task-completion.next"),
        join(root, "recovered-task-completion.json"),
      );
      watcher.close();
    };
    const watcher = watch(join(root, "state"), () => {
      void capture();
    });
    watcher.unref();
    const close = harness.close.bind(harness);
    harness.close = async (...args) => {
      watcher.close();
      return close(...args);
    };
    void capture();
  }
  const commit = harness.commit.bind(harness);
  harness.commit = async (...args) => {
    const result = await commit(...args);
    if (!root || !existsSync(join(root, "kill-terminal"))) return result;
    const store = await harness.snapshot(jobs, BACKGROUND_CONTEXT);
    if (!Object.values(store?.jobs ?? {}).some((job) => job.view.state.kind === "terminal"))
      return result;
    const database = new DatabaseSync(join(root, "state/jobs.sqlite"), { readOnly: true });
    const tasks = database.prepare("SELECT kind, status FROM tasks").all();
    database.close();
    writeFileSync(
      join(root, "terminal-crash-receipt.next"),
      JSON.stringify({ states: Object.values(store.jobs).map((job) => job.view.state), tasks }),
    );
    renameSync(
      join(root, "terminal-crash-receipt.next"),
      join(root, "terminal-crash-receipt.json"),
    );
    renameSync(join(root, "kill-terminal"), join(root, "terminal-fault-consumed"));
    process.kill(process.pid, "SIGKILL");
    return result;
  };
  return harness;
};
