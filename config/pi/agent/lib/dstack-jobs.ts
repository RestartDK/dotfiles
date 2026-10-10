import { request } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isRecord } from "./model-policy.ts";

export const agentPrefix = "[🫩 Daniel's Agent]\n";
export const authorGate =
  "Checking with the author before changing anything: thumbs up to implement, thumbs down to leave as is, or reply with direction.";
export type Mode = "observe" | "drive";
export type Outcome = "merged" | "closed" | "stopped";
export type JobState =
  | { kind: "watching"; reason: string }
  | { kind: "working"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "cleanup"; reason: string; outcome: Outcome }
  | { kind: "terminal"; reason: string; outcome: Outcome };
export type Registration = { repo: string; pr: number; source: string; mode: Mode };
export type JobView = Registration & {
  id: string;
  createdAt: number;
  updatedAt: number;
  observedAt: number | null;
  wakeAt: number;
  state: JobState;
  head: string | null;
  verdict: string | null;
  runs: number;
  maxRuns: number;
  resources: { kind: string; handle: string; disposition: string; receipt: string }[];
  pending: string[];
  history: { at: number; event: string }[];
};
export type Snapshot = { version: 1; now: number; jobs: JobView[] };
export type JobRequest =
  | { op: "register"; registration: Registration }
  | { op: "list" }
  | { op: "status"; id: string }
  | { op: "stop"; id: string };
export type Connection =
  | { kind: "online"; snapshot: Snapshot; receivedAt: number }
  | { kind: "offline"; reason: string; last: Snapshot | null };

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected object");
  return value;
}
export function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Expected nonnegative integer");
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value;
}
export function mode(value: unknown): Mode {
  if (value !== "observe" && value !== "drive")
    throw new Error("Choose observe or drive explicitly");
  return value;
}
function outcome(value: unknown): Outcome {
  if (value !== "merged" && value !== "closed" && value !== "stopped")
    throw new Error("Invalid outcome");
  return value;
}
export function parseRegistration(value: unknown): Registration {
  const v = record(value);
  const repo = string(v.repo);
  const pr = number(v.pr);
  const source = string(v.source);
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    repo.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Expected owner/repo");
  if (pr < 1 || !isAbsolute(source) || source.includes("\0"))
    throw new Error("Expected positive PR and absolute checkout path");
  return { repo: repo.toLowerCase(), pr, source, mode: mode(v.mode) };
}
export function jobId(value: unknown): string {
  const id = string(value);
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid job ID");
  return id;
}
export function parseRequest(value: unknown): JobRequest {
  const v = record(value);
  switch (v.op) {
    case "register":
      return { op: v.op, registration: parseRegistration(v.registration) };
    case "list":
      return { op: v.op };
    case "status":
    case "stop":
      return { op: v.op, id: jobId(v.id) };
    default:
      throw new Error("Unknown operation");
  }
}
function parseState(value: unknown): JobState {
  const v = record(value);
  const reason = string(v.reason);
  switch (v.kind) {
    case "watching":
    case "working":
    case "blocked":
      return { kind: v.kind, reason };
    case "cleanup":
    case "terminal":
      return { kind: v.kind, reason, outcome: outcome(v.outcome) };
    default:
      throw new Error("Unknown job state");
  }
}
export function parseSnapshot(value: unknown): Snapshot {
  const v = record(value);
  if (v.version !== 1) throw new Error("Unsupported dstack protocol version");
  const jobs = array(v.jobs).map((raw): JobView => {
    const j = record(raw);
    return {
      ...parseRegistration(j),
      id: jobId(j.id),
      state: parseState(j.state),
      createdAt: number(j.createdAt),
      updatedAt: number(j.updatedAt),
      wakeAt: number(j.wakeAt),
      observedAt: j.observedAt === null ? null : number(j.observedAt),
      head: j.head === null ? null : string(j.head),
      verdict: j.verdict === null ? null : string(j.verdict),
      runs: number(j.runs),
      maxRuns: number(j.maxRuns),
      pending: array(j.pending).map(string),
      resources: array(j.resources).map((raw) => {
        const r = record(raw);
        return {
          kind: string(r.kind),
          handle: string(r.handle),
          disposition: string(r.disposition),
          receipt: string(r.receipt),
        };
      }),
      history: array(j.history).map((raw) => {
        const h = record(raw);
        return { at: number(h.at), event: string(h.event) };
      }),
    };
  });
  return { version: 1, now: number(v.now), jobs };
}
export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.DSTACK_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "dstack")
  );
}
export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSTACK_SOCKET || join(stateDirectory(env), "jobs.sock");
}
export function callJobs(
  input: JobRequest,
  options: { socket?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Snapshot> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    const req = request(
      {
        socketPath: options.socket || socketPath(),
        path: "/v1/jobs",
        method: "POST",
        signal: options.signal,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        res.setEncoding("utf8");
        let result = "";
        res.on("data", (chunk: string) => {
          result += chunk;
          if (Buffer.byteLength(result) > 4 * 1024 * 1024)
            req.destroy(new Error("Job response too large"));
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(result);
            if (res.statusCode !== 200) throw new Error(string(record(parsed).error));
            resolve(parseSnapshot(parsed));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const timeout = setTimeout(
      () => req.destroy(new Error("dstackd request deadline exceeded")),
      options.timeoutMs ?? 5000,
    );
    req.on("close", () => clearTimeout(timeout));
    req.on("error", reject);
    req.end(body);
  });
}
export function subscribeJobs(
  listener: (connection: Connection) => void,
  options: { socket?: string; intervalMs?: number; source?: string } = {},
): () => void {
  const controller = new AbortController();
  let last: Snapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const snapshot = await callJobs(
        { op: "list" },
        { socket: options.socket, signal: controller.signal },
      );
      last = options.source
        ? {
            ...snapshot,
            jobs: snapshot.jobs.filter(
              (j) => j.source === options.source || options.source?.startsWith(`${j.source}/`),
            ),
          }
        : snapshot;
      if (!controller.signal.aborted)
        listener({ kind: "online", snapshot: last, receivedAt: Date.now() });
    } catch {
      if (!controller.signal.aborted)
        listener({ kind: "offline", reason: "dstackd unavailable", last });
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(poll, options.intervalMs ?? 5000);
    }
  };
  void poll();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
export function jobLine(job: JobView, now: number): string {
  const observed =
    job.observedAt === null
      ? "not observed"
      : `${Math.max(0, Math.floor((now - job.observedAt) / 1000))}s ago`;
  return `${job.id.slice(0, 8)} ${job.repo}#${job.pr} ${job.mode} ${job.state.kind} ${job.state.reason} | observed ${observed}; next ${Math.max(0, Math.ceil((job.wakeAt - now) / 1000))}s; runs ${job.runs}/${job.maxRuns}`.replace(
    /[\u0000-\u001f\u007f-\u009f]/g,
    " ",
  );
}
export function replyBody(text: string, marker: string, pending: boolean): string {
  if (!/^[a-f0-9]{32}$/.test(marker) || text.length > 16000 || !text.trim())
    throw new Error("Invalid reply");
  return `${agentPrefix}${text.trim()}\n\n<!-- dstack:${marker} -->${pending ? `\n${authorGate}` : ""}`;
}
