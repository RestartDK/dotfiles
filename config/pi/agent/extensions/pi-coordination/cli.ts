import { parseArgs, type ParseArgsConfig } from "node:util";
import { attemptExitCode } from "./attempt-exit.ts";
import { resolve } from "node:path";
import {
  cancelAttempt,
  describe,
  describeLease,
  listAttempts,
  listLeases,
  POLL_MS,
  readAttempt,
  tail,
  resolveBlocked,
  runInForeground,
  startDetached,
  stateDirectory,
  watch,
  type JobSpec,
} from "./core.ts";

const usage = `pi-coordinator [--dir PATH] COMMAND [OPTIONS] [-- PROGRAM ARGS...]

  exec --resource KEY [--label TEXT] [--id ID] [--owner OWNER] [--revision REF]
       [--cwd PATH] [--wait MS] -- PROGRAM ARGS...
  submit   Same options as exec, without waiting for the command
  watch --id ID [--wait MS]
  status [--id ID] [--limit N]
  list
  cancel --id ID
  resolve --id ID --inspected
  state

One lease per resource key. A command that ends while its process group still
holds the key leaves the key blocked until someone inspects it and resolves it.`;

const options = {
  dir: { type: "string" },
  id: { type: "string" },
  resource: { type: "string" },
  owner: { type: "string" },
  label: { type: "string" },
  revision: { type: "string" },
  cwd: { type: "string" },
  limit: { type: "string" },
  wait: { type: "string" },
  inspected: { type: "boolean" },
  help: { type: "boolean" },
} satisfies NonNullable<ParseArgsConfig["options"]>;
type Values = ReturnType<typeof parseArgs<{ options: typeof options; strict: true }>>["values"];
const defaultOwner = process.env.PI_SESSION_ID ?? "local-operator";

function spec(values: Values, command: string[]): JobSpec {
  const resource = values.resource;
  if (typeof resource !== "string") throw new Error("--resource is required");
  return {
    resource,
    id:
      typeof values.id === "string"
        ? values.id
        : `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
    owner: typeof values.owner === "string" ? values.owner : defaultOwner,
    label: typeof values.label === "string" ? values.label : "unspecified",
    revision: typeof values.revision === "string" ? values.revision : "unversioned",
    cwd: resolve(typeof values.cwd === "string" ? values.cwd : process.cwd()),
    command,
  };
}

function refuse(reason: string): number {
  console.error(reason);
  return 75;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options,
  });
  const [action, ...command] = positionals;
  if (values.help || action === undefined) {
    console.log(usage);
    return 0;
  }
  const root = stateDirectory({
    ...process.env,
    PI_COORD_DIR: values.dir ?? process.env.PI_COORD_DIR,
  });
  const waitMs = values.wait === undefined ? 0 : Number.parseInt(values.wait, 10);

  switch (action) {
    case "exec":
    case "submit": {
      const job = spec(values, command);
      if (action === "submit") {
        const result = await startDetached(root, job);
        if (result.kind === "started") {
          console.log(`Started ${result.holder.id} on ${job.resource} with group ${result.pgid}`);
          return 0;
        }
        if (result.kind === "existing") return refuse(`Attempt ${job.id} already exists`);
        if (result.kind === "failed") {
          console.error(describe(result.attempt));
          return 1;
        }
        return refuse(
          `Resource ${job.resource} is not available: ${result.state.kind === "blocked" ? result.state.reason : "held"}`,
        );
      }
      const result = await runInForeground(root, job, {
        waitMs: Number.isFinite(waitMs) ? waitMs : 0,
        onWait: (state) => console.error(`Waiting for ${job.resource}: ${state.kind}`),
      });
      if (result.kind === "settled" || result.kind === "existing") {
        console.log(describe(result.attempt));
        return attemptExitCode(result.attempt);
      }
      if (result.kind === "failed") {
        console.error(describe(result.attempt));
        return 1;
      }
      return refuse(
        `Resource ${job.resource} is not available: ${result.state.kind === "blocked" ? result.state.reason : "held"}`,
      );
    }
    case "watch": {
      if (values.id === undefined) throw new Error("--id is required");
      const deadline = Date.now() + (Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 300000);
      while (Date.now() < deadline) {
        const state = watch(root, values.id);
        if (state.kind === "settled") {
          console.log(describe(state.attempt));
          return attemptExitCode(state.attempt);
        }
        if (state.kind === "missing") return refuse(`No attempt ${values.id} is present`);
        await Bun.sleep(POLL_MS);
      }
      return refuse(`Attempt ${values.id} is still running`);
    }
    case "status": {
      if (typeof values.id === "string") {
        const attempt = readAttempt(root, values.id);
        if (!attempt) return refuse(`No attempt ${values.id} is present`);
        console.log(describe(attempt));
        const output = tail(root, values.id);
        if (output) console.log(output);
        return 0;
      }
      const limit = values.limit === undefined ? 20 : Number.parseInt(values.limit, 10);
      const attempts = listAttempts(root, Number.isFinite(limit) ? limit : 20);
      console.log(attempts.length ? attempts.map(describe).join("\n") : "No retained attempts");
      return 0;
    }
    case "list": {
      const leases = listLeases(root);
      console.log(leases.length ? leases.map(describeLease).join("\n") : "No held resources");
      return 0;
    }
    case "cancel": {
      if (values.id === undefined) throw new Error("--id is required");
      const result = cancelAttempt(root, values.id);
      if (result.kind === "missing") return refuse(`No attempt ${values.id} is holding a resource`);
      console.log(
        result.kind === "cancelled"
          ? `Cancellation sent for ${values.id}`
          : describe(result.attempt),
      );
      return 0;
    }
    case "resolve": {
      if (values.id === undefined) throw new Error("--id is required");
      const attempt = resolveBlocked(root, values.id, { inspected: values.inspected === true });
      console.log(describe(attempt));
      return 0;
    }
    case "state":
      console.log(root);
      return 0;
    default:
      throw new Error(`Unknown command ${action}`);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
