import { existsSync, renameSync, writeFileSync } from "node:fs";
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
    const capture = async (outcomes) => {
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
          outcomes,
          states: Object.values(store?.jobs ?? {}).map((job) => job.view.state),
        }),
      );
      renameSync(
        join(root, "recovered-task-completion.next"),
        join(root, "recovered-task-completion.json"),
      );
      process.send?.({ kind: "dstack-test.recovered" });
      detach();
    };
    const detach = harness.subscribeCommits((publication) => {
      const terminal = publication.changes.filter(
        (change) =>
          change.type === "task" &&
          change.value.kind === "dstack.pr" &&
          change.value.state.status === "terminal",
      );
      if (!terminal.length) return;
      setImmediate(() => {
        void capture(terminal.map((change) => change.value.state.outcome)).catch((error) => {
          detach();
          process.send?.({
            kind: "dstack-test.failed",
            reason: error instanceof Error ? error.message : String(error),
          });
        });
      });
    });
    harness.subscribeClose(detach);
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
