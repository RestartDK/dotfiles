import { createHash } from "node:crypto";
import {
  array,
  number,
  record,
  string,
  type JobView,
  type Registration,
} from "../../../config/pi/agent/lib/dstack-jobs.js";

export type Thread = {
  id: string;
  kind: "bot" | "owner" | "human";
  author: string;
  url: string;
  body: string;
  decision: "unanswered" | "pending" | "implement" | "skip" | "direction";
  direction: string;
  generation: string;
  approval: string;
};
export type Observation = {
  head: string;
  branch: string;
  author: string;
  lifecycle: "OPEN" | "MERGED" | "CLOSED";
  verdict: string;
  conflict: boolean;
  fork: boolean;
  failing: string[];
  threads: Thread[];
  resolvedThreads: Thread[];
  observedAt: number;
};
export type Verdict = { id: string; verdict: "fix" | "dismiss" | "ask" | "answer"; reason: string };
export type WorkerResult = {
  summary: string;
  ci: "fixed" | "blocked" | "none";
  threads: Verdict[];
};
export type WorkEvidence = { threads: { id: string; comments: string[] }[]; ciLogs: string[] };
export type Work = {
  kind: "triage" | "repair";
  key: string;
  head: string;
  threads: Thread[];
  failing: string[];
};
export type Effect =
  | { kind: "reply"; thread: string; body: string; marker: string }
  | { kind: "resolve"; thread: string }
  | { kind: "review"; reviewer: string; body: string; marker: string; bot: boolean }
  | { kind: "push"; head: string; branch: string };
export type PendingEffect = {
  key: string;
  head: string;
  authority: Thread[];
  effect: Effect;
  state: "planned" | "intent" | "uncertain";
};
export type WorkerResource = {
  token: string;
  disposition: "intent" | "running" | "released";
  receipt: string;
};
export type Run = {
  work: Work;
  state: "intent" | "finished" | "handled";
  result: WorkerResult | null;
  session: string;
};
export type Job = {
  view: JobView;
  stop: boolean;
  observation: Observation | null;
  failures: number;
  worktree: {
    path: string;
    state: "intent" | "ready" | "releasing" | "retained";
    head: string;
  } | null;
  io: WorkerResource;
  worker: WorkerResource | null;
  run: Run | null;
  effects: PendingEffect[];
  receipts: { key: string; effect: Effect; at: number }[];
  archive: JobView["resources"];
  handled: string[];
  approved: { head: string; threads: Thread[] } | null;
  fatal: string | null;
};
export type Store = { jobs: Record<string, Job> };

export function digest(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Snapshot is not JSON data");
  return createHash("sha256").update(encoded).digest("hex").slice(0, 32);
}
export function freshJob(
  id: string,
  registration: Registration,
  now: number,
  maxRuns: number,
): Job {
  return {
    view: {
      ...registration,
      id,
      createdAt: now,
      updatedAt: now,
      observedAt: null,
      wakeAt: now,
      state: { kind: "watching", reason: "admitted" },
      head: null,
      verdict: null,
      runs: 0,
      maxRuns,
      resources: [],
      pending: [],
      history: [{ at: now, event: "durably admitted" }],
    },
    stop: false,
    observation: null,
    failures: 0,
    worktree: null,
    io: {
      token: digest(["io", id]),
      disposition: "intent",
      receipt: "external command scope registered before observation",
    },
    worker: null,
    run: null,
    effects: [],
    receipts: [],
    archive: [],
    handled: [],
    approved: null,
    fatal: null,
  };
}
export function event(job: Job, message: string, now = Date.now()): void {
  job.view.updatedAt = now;
  if (job.view.history.at(-1)?.event !== message)
    job.view.history.push({ at: now, event: message });
}
export function publicView(job: Job): JobView {
  return {
    ...job.view,
    history: job.view.history.slice(-10).map((h) => ({ ...h, event: h.event.slice(0, 512) })),
    resources: [
      ...job.archive,
      {
        kind: "checkout",
        handle: job.view.source,
        disposition: "borrowed",
        receipt: "never edited or removed",
      },
      ...(job.worktree
        ? [
            {
              kind: "worktree",
              handle: job.worktree.path,
              disposition: job.worktree.state,
              receipt: "owned; data retained",
            },
          ]
        : []),
      {
        kind: "observers-and-effects",
        handle: job.io.token,
        disposition: job.io.disposition,
        receipt: job.io.receipt,
      },
      ...(job.worker
        ? [
            {
              kind: "worker",
              handle: job.worker.token,
              disposition: job.worker.disposition,
              receipt: job.worker.receipt,
            },
          ]
        : []),
      ...(job.run
        ? [
            {
              kind: "session",
              handle: job.run.session,
              disposition: "retained",
              receipt: job.run.state,
            },
          ]
        : []),
    ],
    pending: job.effects.map((e) => `${e.effect.kind} ${e.state}`),
  };
}
export function parseObserver(
  value: unknown,
): Pick<Observation, "verdict" | "failing" | "threads" | "resolvedThreads"> {
  const v = record(value);
  if (v.complete !== true) throw new Error("Incomplete review observation");
  const verdict = string(v.verdict);
  if (
    ![
      "MERGED",
      "CLOSED",
      "CONFLICT",
      "CI_FAIL",
      "THREADS",
      "HUMAN_PENDING",
      "WAITING",
      "REVIEW",
      "READY",
    ].includes(verdict)
  )
    throw new Error("Unknown observer verdict");
  const parseThreads = (value: unknown): Thread[] =>
    array(value).map((raw): Thread => {
      const t = record(raw);
      const kind = t.kind;
      if (kind !== "bot" && kind !== "owner" && kind !== "human")
        throw new Error("Unknown thread kind");
      const observedDecision = kind === "human" ? t.decision : "implement";
      if (
        observedDecision !== "unanswered" &&
        observedDecision !== "pending" &&
        observedDecision !== "implement" &&
        observedDecision !== "skip" &&
        observedDecision !== "direction"
      )
        throw new Error("Unknown human decision");
      let decision: Thread["decision"] = observedDecision;
      const direction = t.direction === undefined ? "" : string(t.direction);
      const generation = digest(array(t.discussion));
      if (
        kind === "human" &&
        ["implement", "direction", "skip"].includes(decision) &&
        t.gate_generation !== generation
      )
        decision = "unanswered";
      return {
        id: string(t.id),
        kind,
        decision,
        author: string(t.author),
        url: string(t.url),
        body: string(t.body),
        direction,
        generation,
        approval: digest(t.approval ?? null),
      };
    });
  const threads = parseThreads(v.threads);
  const resolvedThreads = parseThreads(v.resolved_threads);
  if (threads.length + resolvedThreads.length > 100)
    throw new Error("Observer thread pagination limit reached");
  return { verdict, failing: array(v.failing_checks).map(string), threads, resolvedThreads };
}
export function parseMetadata(value: unknown): {
  head: string;
  branch: string;
  author: string;
  lifecycle: Observation["lifecycle"];
  conflict: boolean;
  fork: boolean;
} {
  const v = record(value);
  const lifecycle = v.state;
  const head = string(v.headRefOid);
  const branch = string(v.headRefName);
  if (lifecycle !== "OPEN" && lifecycle !== "MERGED" && lifecycle !== "CLOSED")
    throw new Error("Invalid PR lifecycle");
  if (
    !/^[a-f0-9]{40,64}$/.test(head) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock")
  )
    throw new Error("Invalid PR revision");
  if (typeof v.isCrossRepository !== "boolean") throw new Error("Missing PR repository identity");
  return {
    lifecycle,
    head,
    branch,
    author: string(record(v.author).login),
    conflict: v.mergeable === "CONFLICTING",
    fork: v.isCrossRepository,
  };
}
export function parseWorkerResult(value: unknown, work: Work): WorkerResult {
  const v = record(value);
  const ci = v.ci;
  if (ci !== "fixed" && ci !== "blocked" && ci !== "none")
    throw new Error("Invalid worker CI verdict");
  if (work.failing.length ? ci === "none" : ci !== "none")
    throw new Error("CI verdict does not classify the selected failures");
  const threads = array(v.threads).map((raw): Verdict => {
    const t = record(raw);
    const verdict = t.verdict;
    if (verdict !== "fix" && verdict !== "dismiss" && verdict !== "ask" && verdict !== "answer")
      throw new Error("Invalid review verdict");
    const id = string(t.id);
    const reason = string(t.reason);
    if (!work.threads.some((t) => t.id === id) || !reason.trim() || reason.length > 8000)
      throw new Error("Invalid worker thread");
    return { id, verdict, reason };
  });
  if (
    threads.length !== work.threads.length ||
    new Set(threads.map((t) => t.id)).size !== threads.length
  )
    throw new Error("Worker must triage every selected thread exactly once");
  return { summary: string(v.summary).slice(0, 8000), ci, threads };
}
export function chooseWork(job: Job, observation: Observation): Work | null {
  const head = observation.head;
  const triage = observation.threads.filter(
    (t) =>
      (t.kind === "bot" || (t.kind === "human" && t.decision === "unanswered")) &&
      !job.handled.includes(digest(["triage", head, t])),
  );
  const triageKey = digest(["triage", head, triage]);
  if (triage.length && !job.handled.includes(triageKey))
    return { kind: "triage", key: triageKey, head, threads: triage, failing: [] };
  const threads = observation.threads
    .filter(
      (t) =>
        t.kind === "owner" ||
        (t.kind === "human" && ["implement", "direction"].includes(t.decision)) ||
        (t.kind === "bot" &&
          job.approved?.head === head &&
          job.approved.threads.some((approved) => digest(approved) === digest(t))),
    )
    .filter((t) => !job.handled.includes(digest(["repair", head, t])));
  const failing = job.handled.includes(digest(["ci", head, observation.failing]))
    ? []
    : observation.failing;
  const key = digest(["repair", head, threads, failing]);
  return (threads.length || failing.length) && !job.handled.includes(key)
    ? { kind: "repair", key, head, threads, failing }
    : null;
}
export function assertAuthority(selected: Thread[], observation: Observation): void {
  const current = [...observation.threads, ...observation.resolvedThreads];
  for (const thread of selected) {
    const now = current.find((candidate) => candidate.id === thread.id);
    if (!now || digest(now) !== digest(thread))
      throw new Error(
        "Review generation or author approval changed; retained work requires reconciliation",
      );
  }
}
export function claimsSelectedFix(work: Work, result: WorkerResult): boolean {
  return (
    (work.failing.length > 0 && result.ci === "fixed") ||
    result.threads.some(
      (verdict) =>
        verdict.verdict === "fix" && work.threads.some((thread) => thread.id === verdict.id),
    )
  );
}
export function parsePr(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Invalid PR number");
  return number(Number(value));
}
