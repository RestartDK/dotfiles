import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FORMAT_VERSION = 1;
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

export function decodeKey(encoded: string): string {
  return encoded.replace(/%2F/g, "/").replace(/%25/g, "%");
}

export function assertId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid attempt id ${JSON.stringify(id)}`);
  return id;
}

function leasesDir(root: string): string {
  return join(root, "leases");
}

function attemptsDir(root: string): string {
  return join(root, "attempts");
}

function queueDir(root: string): string {
  return join(root, "queue");
}

function leaseDir(root: string, resource: string): string {
  return join(leasesDir(root), encodeKey(resource));
}

function keyQueueDir(root: string, resource: string): string {
  return join(queueDir(root), encodeKey(resource));
}

export function attemptPath(root: string, id: string): string {
  return join(attemptsDir(root), `${assertId(id)}.json`);
}

export function logPath(root: string, id: string): string {
  return join(attemptsDir(root), `${assertId(id)}.log`);
}

export function ensureState(root: string): void {
  for (const dir of [root, leasesDir(root), attemptsDir(root), queueDir(root)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export function groupAlive(pgid: number): boolean {
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
  return {
    kind: "blocked",
    holder,
    reason: "Holder exited without recording an outcome; inspect the resource before resolving",
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

export function writeAttempt(root: string, attempt: Attempt): void {
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

function waitMarkerPath(root: string, resource: string, id: string): string {
  mkdirSync(keyQueueDir(root, resource), { recursive: true, mode: 0o700 });
  return join(
    keyQueueDir(root, resource),
    `${Date.now().toString().padStart(13, "0")}-${assertId(id)}.wait`,
  );
}

function ownMarker(root: string, resource: string, id: string): string | undefined {
  const dir = keyQueueDir(root, resource);
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((entry) => entry.endsWith(`-${id}.wait`));
  return name === undefined ? undefined : join(dir, name);
}

function queueHead(root: string, resource: string): string | undefined {
  const dir = keyQueueDir(root, resource);
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".wait"))
    .sort()[0];
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
  let mine: string | undefined;
  for (;;) {
    const state = readLease(root, spec.resource);
    if (state.kind === "blocked") return { ok: false, state };
    if (state.kind === "free") {
      const head = queueHead(root, spec.resource);
      const owned = ownMarker(root, spec.resource, spec.id);
      const mayTake =
        head === undefined || (owned !== undefined && head === owned.split("/").pop());
      if (mayTake && tryTake(root, spec)) {
        if (owned && existsSync(owned)) unlinkSync(owned);
        const holder = readHolder(root, spec.resource);
        if (holder === "corrupt" || holder === undefined)
          throw new Error("Lease vanished after creation");
        return { ok: true, holder };
      }
    }
    if (Date.now() >= deadline) {
      if (mine && existsSync(mine)) unlinkSync(mine);
      return { ok: false, state };
    }
    options.onWait?.(state);
    if (mine === undefined) mine = waitMarkerPath(root, spec.resource, spec.id);
    await sleep(POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function settle(root: string, holder: Holder, exitCode?: number): Attempt {
  const survivors = !groupConfirmedAbsent(holder.pgid);
  const attempt: Attempt = {
    version: FORMAT_VERSION,
    id: holder.id,
    owner: holder.owner,
    resource: holder.resource,
    label: holder.label,
    revision: holder.revision,
    cwd: holder.cwd,
    startedAt: holder.startedAt,
    finishedAt: new Date().toISOString(),
    pgid: holder.pgid,
    exitCode,
    outcome: holder.cancelRequested ? "cancelled" : exitCode === 0 ? "completed" : "failed",
    state: survivors ? "blocked" : "settled",
  };
  if (survivors)
    attempt.reason =
      "Command exited but its process group is still alive; inspect before resolving";
  if (survivors) writeHolder(root, { ...holder, state: "blocked", reason: attempt.reason });
  writeAttempt(root, attempt);
  if (!survivors) rmSync(leaseDir(root, holder.resource), { recursive: true, force: true });
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

function spawnCommand(spec: JobSpec, mode: "inherit" | { logFile: string }): ChildProcess {
  assertCommand(spec.command);
  if (mode === "inherit") {
    return spawn(spec.command[0], spec.command.slice(1), {
      cwd: spec.cwd,
      detached: true,
      stdio: "inherit",
    });
  }
  const redirect = 'log=$1; shift; exec >>"$log" 2>&1; exec "$@"';
  return spawn("/bin/sh", ["-c", redirect, "pi-coordination", mode.logFile, ...spec.command], {
    cwd: spec.cwd,
    detached: true,
    stdio: "ignore",
  });
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

function failedStart(root: string, spec: JobSpec, error: unknown): Attempt {
  const detail = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();
  const attempt: Attempt = {
    version: FORMAT_VERSION,
    id: spec.id,
    owner: spec.owner,
    resource: spec.resource,
    label: spec.label,
    revision: spec.revision,
    cwd: spec.cwd,
    startedAt: now,
    finishedAt: now,
    outcome: "failed",
    state: "settled",
    reason: `Command failed to start: ${detail}`,
  };
  writeAttempt(root, attempt);
  rmSync(leaseDir(root, spec.resource), { recursive: true, force: true });
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
    child = spawnCommand(spec, { logFile: logPath(root, spec.id) });
  } catch (error) {
    return { kind: "failed", attempt: failedStart(root, spec, error) };
  }
  if (child.pid === undefined) {
    const error = await new Promise<unknown>((resolve) => child.once("error", resolve));
    return { kind: "failed", attempt: failedStart(root, spec, error) };
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
    child = spawnCommand(spec, "inherit");
  } catch (error) {
    return { kind: "failed", attempt: failedStart(root, spec, error) };
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
  if (!outcome.ok) return { kind: "failed", attempt: failedStart(root, spec, outcome.error) };
  return { kind: "settled", attempt: settle(root, holder, outcome.exitCode) };
}

export type WatchResult =
  | { kind: "running"; holder: Holder }
  | { kind: "settled"; attempt: Attempt }
  | { kind: "missing" };

export function watch(root: string, id: string): WatchResult {
  const attempt = readAttempt(root, id);
  if (attempt) return { kind: "settled", attempt };
  const found = findLeaseById(root, id);
  if (!found) return { kind: "missing" };
  const holder = found.state.kind === "free" ? undefined : found.state.holder;
  if (!holder) return { kind: "missing" };
  if (groupConfirmedAbsent(holder.pgid)) return { kind: "settled", attempt: settle(root, holder) };
  return { kind: "running", holder };
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

export function findLeaseById(root: string, id: string): LeaseListItem | undefined {
  return listLeases(root).find((item) => {
    const holder = item.state.kind === "free" ? undefined : item.state.holder;
    return holder?.id === id;
  });
}

export type CancelResult =
  | { kind: "cancelled"; holder: Holder }
  | { kind: "settled"; attempt: Attempt }
  | { kind: "missing" };

export function cancelAttempt(root: string, id: string): CancelResult {
  const found = findLeaseById(root, id);
  if (!found) {
    const attempt = readAttempt(root, id);
    return attempt ? { kind: "settled", attempt } : { kind: "missing" };
  }
  const holder = found.state.kind === "free" ? undefined : found.state.holder;
  if (!holder || holder.pgid === undefined) return { kind: "missing" };
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

export function resolveBlocked(root: string, id: string, inspected: boolean): Attempt {
  if (!inspected)
    throw new Error("Inspect the resource and the process group, then pass --inspected");
  const found = findLeaseById(root, id);
  if (!found) throw new Error(`No attempt ${id} is holding a resource`);
  const holder = found.state.kind === "free" ? undefined : found.state.holder;
  if (!holder) throw new Error(`No attempt ${id} is holding a resource`);
  if (!groupConfirmedAbsent(holder.pgid)) {
    throw new Error("Recorded process group is not confirmed absent; the resource stays blocked");
  }
  const attempt: Attempt = {
    version: FORMAT_VERSION,
    id: holder.id,
    owner: holder.owner,
    resource: holder.resource,
    label: holder.label,
    revision: holder.revision,
    cwd: holder.cwd,
    startedAt: holder.startedAt,
    finishedAt: new Date().toISOString(),
    pgid: holder.pgid,
    outcome: "unknown",
    state: "blocked",
    reason: "Operator acknowledged inspection; outcome remains unknown",
  };
  writeAttempt(root, attempt);
  rmSync(leaseDir(root, holder.resource), { recursive: true, force: true });
  return attempt;
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
