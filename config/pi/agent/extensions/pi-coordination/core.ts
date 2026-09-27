import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FORMAT_VERSION = 1;
export const POLL_MS = 150;
const KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}:[^\s]{1,240}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export type Outcome = "completed" | "failed" | "cancelled" | "unknown";
export type LeaseState = "starting" | "running" | "blocked";

export interface JobSpec {
  resource: string;
  id: string;
  owner: string;
  label: string;
  revision: string;
  cwd: string;
  command: string[];
}

export interface Holder {
  version: number;
  id: string;
  owner: string;
  resource: string;
  label: string;
  revision: string;
  cwd: string;
  startedAt: string;
  pgid?: number;
  clientPid?: number;
  state: LeaseState;
  reason?: string;
  cancelRequested?: boolean;
}

export interface Attempt {
  version: number;
  id: string;
  owner: string;
  resource: string;
  label: string;
  revision: string;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  pgid?: number;
  exitCode?: number;
  outcome: Outcome;
  state: "settled" | "blocked";
  reason?: string;
}

export type LeaseRead =
  | { kind: "free" }
  | { kind: "held"; holder: Holder }
  | { kind: "blocked"; holder?: Holder; reason: string };

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_COORD_DIR) return env.PI_COORD_DIR;
  const base = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "pi-coordination");
}

export function encodeKey(key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `Invalid resource key ${JSON.stringify(key)}. Use scope:value, for example device:x4`,
    );
  }
  return key.replace(/%/g, "%25").replace(/\//g, "%2F");
}

function decodeKey(encoded: string): string {
  return encoded.replace(/%2F/g, "/").replace(/%25/g, "%");
}

function assertId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid attempt id ${JSON.stringify(id)}`);
  return id;
}

function leasesDir(root: string): string {
  return join(root, "leases");
}

function attemptsDir(root: string): string {
  return join(root, "attempts");
}

function leaseDir(root: string, resource: string): string {
  return join(leasesDir(root), encodeKey(resource));
}

function attemptPath(root: string, id: string): string {
  return join(attemptsDir(root), `${assertId(id)}.json`);
}

export function logPath(root: string, id: string): string {
  return join(attemptsDir(root), `${assertId(id)}.log`);
}

function statusPath(root: string, id: string): string {
  return join(attemptsDir(root), `${assertId(id)}.status`);
}

function ensureState(root: string): void {
  for (const dir of [root, leasesDir(root), attemptsDir(root)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export function groupConfirmedAbsent(pgid: number | undefined): boolean {
  if (pgid === undefined) return false;
  try {
    return !groupAlive(pgid);
  } catch {
    return false;
  }
}

function readHolder(root: string, resource: string): Holder | "corrupt" | undefined {
  const path = join(leaseDir(root, resource), "holder");
  if (!existsSync(path)) return existsSync(leaseDir(root, resource)) ? "corrupt" : undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "corrupt";
  }
  if (typeof parsed !== "object" || parsed === null) return "corrupt";
  const holder = parsed as Partial<Holder>;
  if (holder.version !== FORMAT_VERSION) return "corrupt";
  if (typeof holder.id !== "string" || typeof holder.owner !== "string") return "corrupt";
  if (typeof holder.resource !== "string" || typeof holder.startedAt !== "string") return "corrupt";
  if (holder.state !== "starting" && holder.state !== "running" && holder.state !== "blocked")
    return "corrupt";
  if (holder.pgid !== undefined && (typeof holder.pgid !== "number" || holder.pgid <= 0))
    return "corrupt";
  if (
    holder.clientPid !== undefined &&
    (typeof holder.clientPid !== "number" || holder.clientPid <= 0)
  )
    return "corrupt";
  return {
    version: FORMAT_VERSION,
    id: holder.id,
    owner: holder.owner,
    resource: holder.resource,
    label: holder.label ?? "",
    revision: holder.revision ?? "unversioned",
    cwd: holder.cwd ?? "",
    startedAt: holder.startedAt,
    pgid: holder.pgid,
    clientPid: holder.clientPid,
    state: holder.state,
    reason: holder.reason,
    cancelRequested: holder.cancelRequested,
  };
}

export function readLease(root: string, resource: string): LeaseRead {
  if (!existsSync(leaseDir(root, resource))) return { kind: "free" };
  const holder = readHolder(root, resource);
  if (holder === undefined) return { kind: "free" };
  if (holder === "corrupt") {
    return { kind: "blocked", reason: "Lease record is unreadable, unknown, or incomplete" };
  }
  if (holder.state === "blocked") {
    return { kind: "blocked", holder, reason: holder.reason ?? "Holder reported blocked" };
  }
  if (holder.state === "starting") {
    if (holder.clientPid !== undefined && processAlive(holder.clientPid))
      return { kind: "held", holder };
    return {
      kind: "blocked",
      holder,
      reason: "The taker died before the command recorded a process group",
    };
  }
  if (holder.pgid === undefined) {
    return { kind: "blocked", holder, reason: "Holder never recorded a process group" };
  }
  if (groupAlive(holder.pgid)) return { kind: "held", holder };
  const recorded = readStatus(root, holder.id);
  if (recorded !== undefined) {
    settle(root, holder, recorded);
    return { kind: "free" };
  }
  return {
    kind: "blocked",
    holder,
    reason: "Holder exited without recording an exit status; inspect the resource before resolving",
  };
}

function writeHolder(root: string, holder: Holder): void {
  writeFileSync(
    join(leaseDir(root, holder.resource), "holder"),
    `${JSON.stringify(holder, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

function writeAttempt(root: string, attempt: Attempt): void {
  ensureState(root);
  writeFileSync(attemptPath(root, attempt.id), `${JSON.stringify(attempt, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function readAttempt(root: string, id: string): Attempt | undefined {
  const path = attemptPath(root, id);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Attempt;
    return parsed.version === FORMAT_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function tryTake(root: string, spec: JobSpec): boolean {
  ensureState(root);
  try {
    mkdirSync(leaseDir(root, spec.resource), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  writeHolder(root, {
    version: FORMAT_VERSION,
    id: spec.id,
    owner: spec.owner,
    resource: spec.resource,
    label: spec.label,
    revision: spec.revision,
    cwd: spec.cwd,
    startedAt: new Date().toISOString(),
    clientPid: process.pid,
    state: "starting",
  });
  return true;
}

export type AcquireResult = { ok: true; holder: Holder } | { ok: false; state: LeaseRead };

export interface AcquireOptions {
  waitMs?: number;
  onWait?: (state: LeaseRead) => void;
}

export async function acquire(
  root: string,
  spec: JobSpec,
  options: AcquireOptions = {},
): Promise<AcquireResult> {
  const waitMs = options.waitMs ?? 0;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const state = readLease(root, spec.resource);
    if (state.kind === "blocked") return { ok: false, state };
    if (state.kind === "free" && tryTake(root, spec)) {
      const holder = readHolder(root, spec.resource);
      if (holder === "corrupt" || holder === undefined)
        throw new Error("Lease vanished after creation");
      return { ok: true, holder };
    }
    if (Date.now() >= deadline) return { ok: false, state };
    options.onWait?.(state);
    await sleep(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attemptOf(
  holder: Holder,
  fields: Pick<Attempt, "finishedAt" | "outcome" | "state"> & {
    exitCode?: number;
    reason?: string;
  },
): Attempt {
  return {
    version: FORMAT_VERSION,
    id: holder.id,
    owner: holder.owner,
    resource: holder.resource,
    label: holder.label,
    revision: holder.revision,
    cwd: holder.cwd,
    startedAt: holder.startedAt,
    pgid: holder.pgid,
    finishedAt: fields.finishedAt,
    exitCode: fields.exitCode,
    outcome: fields.outcome,
    state: fields.state,
    reason: fields.reason,
  };
}

function readStatus(root: string, id: string): number | undefined {
  const path = statusPath(root, id);
  if (!existsSync(path)) return undefined;
  const parsed = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function quarantine(root: string, holder: Holder, reason: string): Attempt {
  const attempt = attemptOf(holder, {
    finishedAt: new Date().toISOString(),
    outcome: "unknown",
    state: "blocked",
    reason,
  });
  writeHolder(root, { ...holder, state: "blocked", reason });
  writeAttempt(root, attempt);
  return attempt;
}

function settle(root: string, holder: Holder, exitCode?: number): Attempt {
  const survivors = !groupConfirmedAbsent(holder.pgid);
  const reason = survivors
    ? "Command exited but its process group is still alive; inspect before resolving"
    : undefined;
  const attempt = attemptOf(holder, {
    finishedAt: new Date().toISOString(),
    exitCode,
    outcome: holder.cancelRequested ? "cancelled" : exitCode === 0 ? "completed" : "failed",
    state: survivors ? "blocked" : "settled",
    reason,
  });
  if (survivors) writeHolder(root, { ...holder, state: "blocked", reason });
  writeAttempt(root, attempt);
  if (!survivors) {
    rmSync(leaseDir(root, holder.resource), { recursive: true, force: true });
    rmSync(statusPath(root, holder.id), { force: true });
  }
  return attempt;
}

function assertCommand(command: string[]): void {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== "string")
  ) {
    throw new Error("Command must be a non-empty array of strings");
  }
}

function resolveExecutable(command: string): string | undefined {
  if (command.includes("/")) return existsSync(command) ? command : undefined;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir !== "" && existsSync(join(dir, command))) return join(dir, command);
  }
  return undefined;
}

function spawnCommand(
  root: string,
  spec: JobSpec,
  mode: "inherit" | { logFile: string },
): ChildProcess {
  assertCommand(spec.command);
  if (resolveExecutable(spec.command[0]) === undefined)
    throw new Error(`Command not found: ${spec.command[0]}`);
  if (mode === "inherit") {
    return spawn(spec.command[0], spec.command.slice(1), {
      cwd: spec.cwd,
      detached: true,
      stdio: "inherit",
    });
  }
  // Bun rejects numeric stdio descriptors, so the wrapper redirects the log and records the status.
  const wrapper =
    'log=$1; status=$2; shift 2; { "$@"; code=$?; echo "$code" > "$status"; exit "$code"; } >>"$log" 2>&1';
  return spawn(
    "/bin/sh",
    ["-c", wrapper, "pi-coordination", mode.logFile, statusPath(root, spec.id), ...spec.command],
    { cwd: spec.cwd, detached: true, stdio: "ignore" },
  );
}

function running(root: string, spec: JobSpec, pgid: number | undefined): Holder {
  const holder: Holder = {
    version: FORMAT_VERSION,
    id: spec.id,
    owner: spec.owner,
    resource: spec.resource,
    label: spec.label,
    revision: spec.revision,
    cwd: spec.cwd,
    startedAt: new Date().toISOString(),
    pgid,
    clientPid: process.pid,
    state: "running",
  };
  writeHolder(root, holder);
  return holder;
}

function currentHolder(root: string, spec: JobSpec): Holder {
  const holder = readHolder(root, spec.resource);
  if (holder === undefined || holder === "corrupt")
    throw new Error("Lease vanished after creation");
  return holder;
}

function failedStart(root: string, holder: Holder, error: unknown): Attempt {
  const detail = error instanceof Error ? error.message : String(error);
  const attempt = attemptOf(holder, {
    finishedAt: new Date().toISOString(),
    outcome: "failed",
    state: "settled",
    reason: `Command failed to start: ${detail}`,
  });
  writeAttempt(root, attempt);
  rmSync(leaseDir(root, holder.resource), { recursive: true, force: true });
  rmSync(statusPath(root, holder.id), { force: true });
  return attempt;
}

export type StartResult =
  | { kind: "started"; holder: Holder; pgid: number }
  | { kind: "refused"; state: LeaseRead }
  | { kind: "existing"; attempt: Attempt }
  | { kind: "failed"; attempt: Attempt };

export async function startDetached(
  root: string,
  spec: JobSpec,
  options: AcquireOptions = {},
): Promise<StartResult> {
  const existing = readAttempt(root, spec.id);
  if (existing) return { kind: "existing", attempt: existing };
  const acquired = await acquire(root, spec, options);
  if (!acquired.ok) return { kind: "refused", state: acquired.state };
  let child: ChildProcess;
  try {
    child = spawnCommand(root, spec, { logFile: logPath(root, spec.id) });
  } catch (error) {
    return { kind: "failed", attempt: failedStart(root, currentHolder(root, spec), error) };
  }
  if (child.pid === undefined) {
    const error = await new Promise<unknown>((resolve) => child.once("error", resolve));
    return { kind: "failed", attempt: failedStart(root, currentHolder(root, spec), error) };
  }
  const holder = running(root, spec, child.pid);
  child.unref();
  return { kind: "started", holder, pgid: child.pid };
}

export type RunResult =
  | { kind: "settled"; attempt: Attempt }
  | { kind: "refused"; state: LeaseRead }
  | { kind: "existing"; attempt: Attempt }
  | { kind: "failed"; attempt: Attempt };

export async function runInForeground(
  root: string,
  spec: JobSpec,
  options: AcquireOptions = {},
): Promise<RunResult> {
  const existing = readAttempt(root, spec.id);
  if (existing) return { kind: "existing", attempt: existing };
  const acquired = await acquire(root, spec, options);
  if (!acquired.ok) return { kind: "refused", state: acquired.state };
  let child: ChildProcess;
  try {
    child = spawnCommand(root, spec, "inherit");
  } catch (error) {
    return { kind: "failed", attempt: failedStart(root, currentHolder(root, spec), error) };
  }
  const holder = running(root, spec, child.pid);
  const outcome = await new Promise<
    { ok: true; exitCode?: number } | { ok: false; error: unknown }
  >((resolve) => {
    child.on("error", (error) => resolve({ ok: false, error }));
    child.on("exit", (code, signal) =>
      resolve({ ok: true, exitCode: signal ? undefined : (code ?? undefined) }),
    );
  });
  if (!outcome.ok) return { kind: "failed", attempt: failedStart(root, holder, outcome.error) };
  return { kind: "settled", attempt: settle(root, holder, outcome.exitCode) };
}

export type WatchResult =
  | { kind: "running"; holder: Holder }
  | { kind: "settled"; attempt: Attempt }
  | { kind: "missing" };

export function watch(root: string, id: string): WatchResult {
  const holder = findLeaseById(root, id);
  if (holder) {
    const recorded = readStatus(root, holder.id);
    if (recorded !== undefined) return { kind: "settled", attempt: settle(root, holder, recorded) };
    if (groupConfirmedAbsent(holder.pgid))
      return {
        kind: "settled",
        attempt: quarantine(
          root,
          holder,
          "The command ended without recording an exit status; inspect before resolving",
        ),
      };
    return { kind: "running", holder };
  }
  const attempt = readAttempt(root, id);
  return attempt ? { kind: "settled", attempt } : { kind: "missing" };
}

export interface LeaseListItem {
  resource: string;
  state: LeaseRead;
}

export function listLeases(root: string): LeaseListItem[] {
  const dir = leasesDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .sort()
    .map((name) => ({ resource: decodeKey(name), state: readLease(root, decodeKey(name)) }));
}

export function listAttempts(root: string, limit = 50): Attempt[] {
  const dir = attemptsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .flatMap((name) => {
      const attempt = readAttempt(root, name.replace(/\.json$/, ""));
      return attempt ? [attempt] : [];
    });
}

function findLeaseById(root: string, id: string): Holder | undefined {
  for (const item of listLeases(root)) {
    if (item.state.kind !== "free" && item.state.holder?.id === id) return item.state.holder;
  }
  return undefined;
}

export type CancelResult =
  | { kind: "cancelled"; holder: Holder }
  | { kind: "settled"; attempt: Attempt }
  | { kind: "missing" };

export function cancelAttempt(root: string, id: string): CancelResult {
  const holder = findLeaseById(root, id);
  if (!holder) {
    const attempt = readAttempt(root, id);
    return attempt ? { kind: "settled", attempt } : { kind: "missing" };
  }
  if (holder.pgid === undefined) return { kind: "missing" };
  try {
    process.kill(-holder.pgid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const blocked: Holder = {
    ...holder,
    state: "blocked",
    cancelRequested: true,
    reason: "Cancellation requested; the group holds the resource until it exits",
  };
  writeHolder(root, blocked);
  return { kind: "cancelled", holder: blocked };
}

export function resolveBlocked(root: string, id: string, options: { inspected: boolean }): Attempt {
  if (!options.inspected)
    throw new Error("Inspect the resource and the process group, then pass --inspected");
  const holder = findLeaseById(root, id);
  if (!holder) throw new Error(`No attempt ${id} is holding a resource`);
  if (!groupConfirmedAbsent(holder.pgid)) {
    throw new Error("Recorded process group is not confirmed absent; the resource stays blocked");
  }
  const attempt = attemptOf(holder, {
    finishedAt: new Date().toISOString(),
    outcome: "unknown",
    state: "blocked",
    reason: "Operator acknowledged inspection; outcome remains unknown",
  });
  writeAttempt(root, attempt);
  rmSync(leaseDir(root, holder.resource), { recursive: true, force: true });
  rmSync(statusPath(root, holder.id), { force: true });
  return attempt;
}

export function tail(root: string, id: string, lines = 20): string {
  const path = logPath(root, id);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

export function describe(attempt: Attempt): string {
  const exit = attempt.exitCode === undefined ? "" : `, exit ${attempt.exitCode}`;
  return `${attempt.id} | ${attempt.resource} | ${attempt.owner} | ${attempt.state}, ${attempt.outcome}${exit} | ${attempt.revision} | ${attempt.label}`;
}

export function describeHolder(holder: Holder): string {
  const group = holder.pgid === undefined ? "" : `, group ${holder.pgid}`;
  return `${holder.id} | ${holder.resource} | ${holder.owner} | ${holder.state}${group} | ${holder.revision} | ${holder.label}`;
}

export function describeLease(item: LeaseListItem): string {
  if (item.state.kind === "free") return `${item.resource} | free`;
  if (!item.state.holder) return `${item.resource} | ${item.state.kind}`;
  const reason = item.state.kind === "blocked" ? ` | ${item.state.reason}` : "";
  return `${describeHolder(item.state.holder)}${reason}`;
}
