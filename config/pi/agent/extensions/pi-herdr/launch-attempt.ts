import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const Phase = Type.Union([
  Type.Literal("reserved"),
  Type.Literal("shell"),
  Type.Literal("environment"),
  Type.Literal("startup"),
]);
const Reason = Type.Union([
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("timedout"),
  Type.Literal("sourceLost"),
]);
const Common = {
  id: Type.String(),
  phase: Phase,
  at: Type.Number(),
  phaseAt: Type.Number(),
  deadline: Type.Number(),
  supervisorPid: Type.Union([Type.Integer(), Type.Null()]),
};
const LaunchStateSchema = Type.Union([
  Type.Object({ ...Common, kind: Type.Literal("active") }),
  Type.Object({ ...Common, kind: Type.Literal("transferred"), phase: Type.Literal("transferred") }),
  Type.Object({
    ...Common,
    kind: Type.Literal("stopping"),
    phase: Type.Union([Phase, Type.Literal("transferred")]),
    reason: Reason,
  }),
  Type.Object({
    ...Common,
    kind: Type.Literal("recoveryRequired"),
    phase: Type.Union([Phase, Type.Literal("transferred")]),
    reason: Reason,
  }),
  Type.Object({
    ...Common,
    kind: Type.Literal("exited"),
    phase: Type.Union([Phase, Type.Literal("transferred")]),
    code: Type.Integer({ minimum: 0, maximum: 255 }),
    reason: Type.Union([Reason, Type.Null()]),
    cleanup: Type.Literal("confirmed"),
  }),
]);
export type LaunchState = Static<typeof LaunchStateSchema>;
export type StopReason = Static<typeof Reason>;
const LaunchOptionsSchema = Type.Object({
  id: Type.String(),
  cwd: Type.String(),
  namespace: Type.Union([Type.String(), Type.Null()]),
  claimPath: Type.Union([Type.String(), Type.Null()]),
  environmentMs: Type.Integer({ minimum: 1 }),
  startupMs: Type.Integer({ minimum: 1 }),
  leaseMs: Type.Integer({ minimum: 1 }),
});
export type LaunchOptions = Static<typeof LaunchOptionsSchema>;

const SourceIdentity = Type.Object({ pid: Type.Integer({ minimum: 1 }), birth: Type.String() });
const exec = promisify(execFile);

export async function processBirth(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const record = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = record.slice(record.lastIndexOf(")") + 2).split(/\s+/);
    if (fields[0] === "Z") throw new Error("Source process exited.");
    const birth = fields[19];
    if (!birth || !/^\d+$/.test(birth)) throw new Error("Invalid source process identity.");
    return `linux:${birth}`;
  }
  const { stdout } = await exec("ps", ["-p", String(pid), "-o", "stat=,lstart="]);
  const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(stdout);
  if (!match || match[1].startsWith("Z")) throw new Error("Source process exited.");
  return `ps:${match[2]}`;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function managedShellEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = { REPO_ENV_MANAGED: "1" };
  for (const key of ["SHELL", "ZDOTDIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export class LaunchAttempt {
  readonly statusPath: string;
  readonly logPath: string;
  constructor(
    readonly directory: string,
    readonly options: LaunchOptions,
  ) {
    this.statusPath = join(directory, "status");
    this.logPath = join(directory, "events.jsonl");
  }

  static async open(directory: string): Promise<LaunchAttempt> {
    const value: unknown = JSON.parse(await readFile(join(directory, "attempt.json"), "utf8"));
    if (!Check(LaunchOptionsSchema, value))
      throw new Error(`Invalid launch attempt at ${directory}.`);
    return new LaunchAttempt(directory, value);
  }

  static async create(cwd: string, namespace: string | null): Promise<LaunchAttempt> {
    const attempt = new LaunchAttempt(await mkdtemp(join(tmpdir(), "pi-herdr-launch-")), {
      id: randomUUID(),
      cwd,
      namespace,
      claimPath: null,
      environmentMs: 600_000,
      startupMs: 60_000,
      leaseMs: 5_000,
    });
    await attempt.prepare();
    return attempt;
  }

  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(join(this.directory, "attempt.json"), JSON.stringify(this.options), {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(
      join(this.directory, "source"),
      JSON.stringify({ pid: process.pid, birth: await processBirth(process.pid) }),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(join(this.directory, "lease"), "", { flag: "wx", mode: 0o600 });
    const now = Date.now();
    const initial: LaunchState = {
      kind: "active",
      id: this.options.id,
      phase: "reserved",
      at: now,
      phaseAt: now,
      deadline: now + this.options.environmentMs,
      supervisorPid: null,
    };
    await writeFile(this.statusPath, JSON.stringify(initial), { flag: "wx", mode: 0o600 });
  }

  command(argv: string[]): string {
    const command = ["repo-exec", ...argv].map(shellQuote).join(" ");
    const namespace = this.options.namespace;
    const namespaceRunner =
      process.env.PI_NETNS_RUN_DEV_NETNS?.trim() || "/run/current-system/sw/bin/run-dev-netns";
    const launch = namespace
      ? `/run/wrappers/bin/sudo -n -E ${shellQuote(namespaceRunner)} ${shellQuote(namespace)} env ZDOTDIR="\${ZDOTDIR:-$HOME}" ${command}`
      : command;
    const failed: LaunchState = {
      kind: "exited",
      id: this.options.id,
      phase: "shell",
      at: Date.now(),
      phaseAt: Date.now(),
      deadline: Date.now(),
      supervisorPid: null,
      code: 127,
      reason: "failed",
      cleanup: "confirmed",
    };
    const failedReceipt = `printf ${shellQuote(JSON.stringify(failed).replace('"code":127', '"code":%s'))} "$launch_result" > ${shellQuote(this.statusPath + ".tmp")}; mv ${shellQuote(this.statusPath + ".tmp")} ${shellQuote(this.statusPath)}`;
    return `( cd ${shellQuote(this.options.cwd)} && REPO_LAUNCH_DIRECTORY=${shellQuote(this.directory)} ${namespace ? `PI_NETNS=${shellQuote(namespace)} PI_NETNS_SELECTED=${shellQuote(namespace)} PI_NETNS_RUN_DEV_NETNS=${shellQuote(namespaceRunner)} ` : ""}${launch}; launch_result=$?; if [ ! -e ${shellQuote(join(this.directory, "started"))} ]; then ${failedReceipt}; fi; exit "$launch_result" )`;
  }

  async read(): Promise<LaunchState> {
    const value: unknown = JSON.parse(await readFile(this.statusPath, "utf8"));
    if (!Check(LaunchStateSchema, value) || value.id !== this.options.id)
      throw new Error(`Invalid launch status at ${this.statusPath}.`);
    return value;
  }

  async pulse(): Promise<void> {
    const now = new Date();
    await utimes(join(this.directory, "lease"), now, now);
  }

  async assertAccepting(): Promise<Extract<LaunchState, { kind: "active" }>> {
    const source: unknown = JSON.parse(await readFile(join(this.directory, "source"), "utf8"));
    if (!Check(SourceIdentity, source) || (await processBirth(source.pid)) !== source.birth)
      throw new Error("Source process ownership changed.");
    const state = await this.read();
    const lease = await stat(join(this.directory, "lease"));
    if (
      state.kind !== "active" ||
      state.phase !== "startup" ||
      Date.now() >= state.deadline ||
      Date.now() - lease.mtimeMs > this.options.leaseMs
    )
      throw new Error(
        `Launch ${this.options.id} is not accepting readiness (${state.kind}/${state.phase}).`,
      );
    try {
      await stat(join(this.directory, "stop"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return state;
      throw error;
    }
    throw new Error(`Launch ${this.options.id} is stopping.`);
  }

  async transfer(signal?: AbortSignal): Promise<void> {
    if ((await this.read()).kind === "transferred") return;
    const candidate = join(this.directory, `authorization-${randomUUID()}`);
    await writeFile(candidate, this.options.id, { flag: "wx", mode: 0o600 });
    const state = await this.assertAccepting();
    signal?.throwIfAborted();
    if (Date.now() >= state.deadline) throw new Error("Launch authorization deadline expired.");
    try {
      linkSync(candidate, join(this.directory, "transferred"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }

  async stop(reason: StopReason): Promise<LaunchState> {
    try {
      await writeFile(join(this.directory, "stop"), reason, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const deadline = performance.now() + 4_000;
    let state = await this.read();
    while (
      state.kind !== "exited" &&
      state.kind !== "transferred" &&
      performance.now() < deadline
    ) {
      await delay(50);
      state = await this.read();
    }
    return state.kind === "exited" || state.kind === "transferred"
      ? state
      : { ...state, kind: "recoveryRequired", reason };
  }

  async waitForStartup(
    signal?: AbortSignal,
    onUpdate?: (state: LaunchState) => void,
  ): Promise<void> {
    try {
      while (true) {
        signal?.throwIfAborted();
        await this.pulse();
        const state = await this.read();
        onUpdate?.(state);
        if (state.kind === "active" && state.phase === "startup") {
          signal?.throwIfAborted();
          await this.transfer(signal);
        }
        if (
          state.kind === "transferred" ||
          (state.kind === "exited" && state.phase === "transferred")
        )
          return;
        if (state.kind === "exited") {
          throw new Error(`Launch exited with status ${state.code} during ${state.phase}.`);
        }
        if (state.kind !== "active" || Date.now() >= state.deadline)
          throw new Error(`Launch ${state.kind} during ${state.phase}.`);
        await delay(50, undefined, { signal });
      }
    } catch (error) {
      const stopped = await this.stop(signal?.aborted ? "cancelled" : "failed");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Cleanup ${stopped.kind}. Diagnostics at ${this.directory}.`,
        { cause: error },
      );
    }
  }
}
