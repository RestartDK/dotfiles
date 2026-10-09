#!/usr/bin/env node
import { resolve } from "node:path";
import {
  callJobs,
  jobLine,
  parseRequest,
  socketPath,
  subscribeJobs,
  type JobRequest,
} from "../../../config/pi/agent/lib/dstack-jobs.js";
import { parsePr } from "./domain.js";
import { herdrContext, openJobsPane, watchJobsPane } from "./herdr.js";

const help = `dstack register --repo OWNER/REPO --pr N --source PATH --mode observe|drive
dstack list
dstack status ID
dstack stop ID
dstack watch [ID] [--json]
dstack attach [ID] [--json]
dstack herdr [--notify]

Registration authorizes only the selected mode. Drive may repair and push the owning branch.
Scoped worker tools are not an OS sandbox.
Stop releases owned processes and retains data. Exiting a viewer never stops a job.
Herdr opens or focuses an owned Jobs pane. --notify enables quiet blocker/terminal notifications in a new viewer.
All non-viewer results are structured JSON. Configuration: DSTACK_SOCKET or DSTACK_STATE_DIR.`;
const args = process.argv.slice(2);
const command = args.shift();
try {
  if (!command || command === "--help" || command === "help") console.log(help);
  else if (command === "herdr") {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--notify"))
      throw new Error("Expected dstack herdr [--notify]");
    const cli = process.argv[1];
    if (!cli) throw new Error("Missing dstack executable path");
    console.log(
      JSON.stringify(
        await openJobsPane({
          ...herdrContext(),
          jobsSocket: resolve(socketPath()),
          node: process.execPath,
          cli: resolve(cli),
          notify: args[0] === "--notify",
        }),
      ),
    );
  } else if (command === "herdr-view") {
    if (args.length) throw new Error("Jobs viewer takes no arguments");
    await watchJobsPane(herdrContext());
  } else if (command === "watch" || command === "attach") {
    const json = args.includes("--json");
    const ids = args.filter((arg) => arg !== "--json");
    if (ids.length > 1) throw new Error("Expected at most one job ID");
    const id = ids[0];
    if (id) parseRequest({ op: "status", id });
    const disconnect = subscribeJobs((connection) => {
      if (json) {
        console.log(JSON.stringify(connection));
        return;
      }
      if (connection.kind === "offline") {
        console.log("OFFLINE: dstackd unavailable; cached state is stale; jobs are not cancelled");
        return;
      }
      const jobs = connection.snapshot.jobs.filter((job) => !id || job.id === id);
      const lines = jobs.length
        ? jobs.map((job) => jobLine(job, connection.snapshot.now))
        : ["No matching jobs."];
      if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
      console.log(["Dstack jobs | Ctrl-C disconnects only", ...lines].join("\n"));
    });
    const stop = () => {
      disconnect();
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else {
    let input: JobRequest;
    if (command === "register") {
      const flags = new Map<string, string>();
      while (args.length) {
        const key = args.shift();
        const value = args.shift();
        if (
          !key ||
          !["--repo", "--pr", "--source", "--mode"].includes(key) ||
          value === undefined ||
          flags.has(key)
        )
          throw new Error("Invalid register arguments");
        flags.set(key, value);
      }
      const source = flags.get("--source");
      input = parseRequest({
        op: "register",
        registration: {
          repo: flags.get("--repo"),
          pr: parsePr(flags.get("--pr") ?? ""),
          source: source === undefined ? undefined : resolve(source),
          mode: flags.get("--mode"),
        },
      });
    } else {
      if (command !== "list" && command !== "status" && command !== "stop")
        throw new Error("Unknown command");
      if (args.length !== (command === "list" ? 0 : 1)) throw new Error("Invalid arguments");
      input = parseRequest({ op: command, id: args[0] });
    }
    console.log(JSON.stringify(await callJobs(input)));
  }
} catch (error) {
  console.error(
    JSON.stringify({ error: error instanceof Error ? error.message : "dstack failed" }),
  );
  process.exitCode = 1;
}
