import { request } from "node:http";
import { array, maxSnapshotBytes, number, record, socketPath, string } from "./dstack-jobs.ts";

export type WatchTrigger =
  | { kind: "timer"; at: number }
  | { kind: "github-checks"; repo: string; pr: number };
export type PinnedTrigger =
  | { kind: "timer"; at: number }
  | { kind: "github-checks"; repo: string; pr: number; head: string };
export type WatchRegistration = {
  requestId: string;
  sessionId: string;
  trigger: WatchTrigger;
  deadline: number;
  message: string;
};
export type WatchResult =
  | { kind: "timer"; at: number }
  | { kind: "checks"; head: string; total: number; failed: number };
export type WatchState =
  | { kind: "watching"; nextAt: number; observations: number; error: string | null }
  | { kind: "pending"; result: WatchResult }
  | { kind: "delivering"; result: WatchResult; token: string; startedAt: number }
  | { kind: "delivered"; result: WatchResult; token: string; entryId: string }
  | { kind: "cancelled" | "expired" | "superseded" | "error"; reason: string };
export type WatchView = Omit<WatchRegistration, "trigger"> & {
  id: string;
  trigger: PinnedTrigger;
  createdAt: number;
  updatedAt: number;
  state: WatchState;
};
export type WatchSnapshot = { version: 1; now: number; watches: WatchView[] };
export type WatchRequest =
  | { op: "create"; registration: WatchRegistration }
  | { op: "list"; sessionId?: string }
  | { op: "status"; id: string }
  | { op: "cancel"; id: string }
  | { op: "begin"; id: string; sessionId: string; token: string }
  | { op: "ack"; id: string; sessionId: string; token: string; entryId: string };
export const watchLimits = {
  active: 64,
  retained: 1024,
  observations: 1440,
  lifetimeMs: 7 * 86400_000,
  pollMs: 60_000,
};
export function watchKey(value: unknown): string {
  const key = string(value);
  if (!/^[A-Za-z0-9_.:/|+-]{1,200}$/.test(key))
    throw new Error("Expected concrete session, request, or receipt ID");
  return key;
}
export function watchId(value: unknown): string {
  const id = string(value);
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid watch ID");
  return id;
}
export function parseTrigger(value: unknown): WatchTrigger {
  const v = record(value);
  if (v.kind === "timer") return { kind: "timer", at: number(v.at) };
  if (v.kind !== "github-checks") throw new Error("Unknown watch trigger");
  const repo = string(v.repo).toLowerCase();
  const pr = number(v.pr);
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    repo.split("/").some((p) => p === "." || p === "..") ||
    pr < 1
  )
    throw new Error("Expected owner/repo and positive PR");
  return { kind: "github-checks", repo, pr };
}
export function parseWatchRegistration(value: unknown): WatchRegistration {
  const v = record(value);
  const message = string(v.message);
  if (!message.trim() || Buffer.byteLength(message) > 4000)
    throw new Error("Message must contain 1 to 4000 UTF-8 bytes");
  const trigger = parseTrigger(v.trigger);
  const deadline = number(v.deadline);
  if (trigger.kind === "timer" && trigger.at >= deadline)
    throw new Error("Timer must precede deadline");
  return {
    requestId: watchKey(v.requestId),
    sessionId: watchKey(v.sessionId),
    trigger,
    deadline,
    message,
  };
}
export function parseWatchRequest(value: unknown): WatchRequest {
  const v = record(value);
  switch (v.op) {
    case "create":
      return { op: v.op, registration: parseWatchRegistration(v.registration) };
    case "list":
      return {
        op: v.op,
        ...(v.sessionId === undefined ? {} : { sessionId: watchKey(v.sessionId) }),
      };
    case "status":
    case "cancel":
      return { op: v.op, id: watchId(v.id) };
    case "begin":
      return {
        op: v.op,
        id: watchId(v.id),
        sessionId: watchKey(v.sessionId),
        token: watchKey(v.token),
      };
    case "ack":
      return {
        op: v.op,
        id: watchId(v.id),
        sessionId: watchKey(v.sessionId),
        token: watchKey(v.token),
        entryId: watchKey(v.entryId),
      };
    default:
      throw new Error("Unknown watch operation");
  }
}
function parseResult(value: unknown): WatchResult {
  const v = record(value);
  if (v.kind === "timer") return { kind: v.kind, at: number(v.at) };
  if (v.kind === "checks")
    return { kind: v.kind, head: string(v.head), total: number(v.total), failed: number(v.failed) };
  throw new Error("Invalid watch result");
}
function parseState(value: unknown): WatchState {
  const v = record(value);
  switch (v.kind) {
    case "watching":
      return {
        kind: v.kind,
        nextAt: number(v.nextAt),
        observations: number(v.observations),
        error: v.error === null ? null : string(v.error),
      };
    case "pending":
      return { kind: v.kind, result: parseResult(v.result) };
    case "delivering":
      return {
        kind: v.kind,
        result: parseResult(v.result),
        token: watchKey(v.token),
        startedAt: number(v.startedAt),
      };
    case "delivered":
      return {
        kind: v.kind,
        result: parseResult(v.result),
        token: watchKey(v.token),
        entryId: watchKey(v.entryId),
      };
    case "cancelled":
    case "expired":
    case "superseded":
    case "error":
      return { kind: v.kind, reason: string(v.reason) };
    default:
      throw new Error("Invalid watch state");
  }
}
export function parseWatch(value: unknown): WatchView {
  const v = record(value);
  const registration = parseWatchRegistration(v);
  const trigger = registration.trigger;
  return {
    ...registration,
    id: watchId(v.id),
    trigger:
      trigger.kind === "timer" ? trigger : { ...trigger, head: string(record(v.trigger).head) },
    createdAt: number(v.createdAt),
    updatedAt: number(v.updatedAt),
    state: parseState(v.state),
  };
}
export function parseWatchSnapshot(value: unknown): WatchSnapshot {
  const v = record(value);
  if (v.version !== 1) throw new Error("Unsupported watch protocol version");
  return { version: 1, now: number(v.now), watches: array(v.watches).map(parseWatch) };
}
export function callWatches(
  input: WatchRequest,
  options: { socket?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<WatchSnapshot> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    const req = request(
      {
        socketPath: options.socket || socketPath(),
        path: "/v1/watches",
        method: "POST",
        signal: options.signal,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        res.setEncoding("utf8");
        let result = "";
        let bytes = 0;
        res.on("data", (chunk: string) => {
          result += chunk;
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxSnapshotBytes) req.destroy(new Error("Watch response too large"));
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(result);
            if (res.statusCode !== 200) throw new Error(string(record(parsed).error));
            resolve(parseWatchSnapshot(parsed));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const timeout = setTimeout(
      () => req.destroy(new Error("dstackd watch request deadline exceeded")),
      options.timeoutMs ?? 35_000,
    );
    req.on("close", () => clearTimeout(timeout));
    req.on("error", reject);
    req.end(body);
  });
}
export function watchLine(watch: WatchView): string {
  const state = watch.state;
  const detail =
    state.kind === "watching"
      ? (state.error ?? `next ${new Date(state.nextAt).toISOString()}`)
      : "reason" in state
        ? state.reason
        : state.kind === "delivering"
          ? "receipt missing; replay blocked"
          : JSON.stringify(state.result);
  return `${watch.id.slice(0, 8)} ${watch.trigger.kind} ${state.kind} ${detail} | session ${watch.sessionId}`
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .slice(0, 500);
}
