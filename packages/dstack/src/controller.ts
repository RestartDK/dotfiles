import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { join } from "node:path";
import {
  replyBody,
  type JobRequest,
  type Outcome,
  type Snapshot,
} from "../../../config/pi/agent/lib/dstack-jobs.js";
import {
  assertAuthority,
  claimsSelectedFix,
  chooseWork,
  digest,
  event,
  freshJob,
  publicView,
  type Effect,
  type Job,
  type PendingEffect,
  type Store,
  type Thread,
} from "./domain.js";
import { Github, type GithubConfig } from "./github.js";
import { releaseProcess, releaseScope } from "./process.js";
import { Workers, type WorkerConfig } from "./worker.js";

export const Jobs = defineDoc<Store>({
  kind: "dstack.jobs",
  version: 1,
  scope: "session",
  initial: () => ({ jobs: {} }),
});
export type ControllerConfig = GithubConfig &
  WorkerConfig & { intervalMs: number; maxRuns: number };
type Checkpoint = { phase: "tick"; iteration: number };
const context = BACKGROUND_CONTEXT;

export async function openController(config: ControllerConfig) {
  const github = new Github(config);
  const workers = new Workers(config);
  const active = new Map<string, AbortController>();
  let harness: Harness;
  async function get(id: string): Promise<Job> {
    const job = (await harness.snapshot(Jobs, context))?.jobs[id];
    if (!job) throw new Error("Unknown job");
    return structuredClone(job);
  }
  async function save(job: Job): Promise<void> {
    await harness.commit(async (tx) => {
      const store = await tx.doc(Jobs);
      if (!job.stop && store.jobs[job.view.id]?.stop) {
        job.stop = true;
        job.view.wakeAt = Date.now();
      }
      store.jobs[job.view.id] = job;
    }, context);
  }
  function enqueue(job: Job, effect: Effect, head: string, authority: Thread[]): void {
    const key = digest([effect, head, authority]);
    if (
      !job.receipts.some((receipt) => receipt.key === key) &&
      !job.effects.some((e) => e.key === key)
    )
      job.effects.push({
        key,
        head,
        authority: structuredClone(authority),
        effect,
        state: "planned",
      });
  }
  function reply(
    job: Job,
    thread: Thread,
    text: string,
    head: string,
    pending: boolean,
    resolve: boolean,
  ): void {
    const marker = digest([job.view.id, thread, head, text, pending]);
    const verdict = pending ? `${text}\n\n<!-- dstack-generation:${thread.generation} -->` : text;
    enqueue(
      job,
      { kind: "reply", thread: thread.id, marker, body: replyBody(verdict, marker, pending) },
      head,
      [thread],
    );
    if (!resolve) return;
    enqueue(job, { kind: "resolve", thread: thread.id }, head, [thread]);
    if (thread.kind === "owner") return;
    const reviewMarker = digest([job.view.id, thread, head, "review"]);
    enqueue(
      job,
      {
        kind: "review",
        reviewer: thread.author,
        bot: thread.kind === "bot",
        marker: reviewMarker,
        body: replyBody(
          `@${thread.author.replace(/\[bot\]$/, "")} review\n\n${text}`,
          reviewMarker,
          false,
        ),
      },
      head,
      [thread],
    );
  }
  async function cleanup(job: Job, outcome: Outcome, signal: AbortSignal): Promise<void> {
    job.view.state = {
      kind: "cleanup",
      outcome,
      reason: "quiescing owned resources; data retained",
    };
    await save(job);
    await releaseScope(job.io.token);
    if (job.worker) {
      await releaseProcess(job.worker.token);
      job.worker.disposition = "released";
      job.worker.receipt = "no process with the registered token remains";
      await save(job);
    }
    if (job.worktree?.state === "ready") {
      job.worktree.state = "releasing";
      await save(job);
    }
    await workers.release(job, signal);
    if (job.worktree) job.worktree.state = "retained";
    await releaseScope(job.io.token);
    job.io.disposition = "released";
    job.io.receipt = "registered observer/effect scope has no remaining processes";
    job.view.state = {
      kind: "terminal",
      outcome,
      reason: "owned workers stopped; worktree/session/database retained",
    };
    event(job, `${outcome}; resource release verified`);
    await save(job);
  }
  async function applyEffect(job: Job, pending: PendingEffect, signal: AbortSignal): Promise<void> {
    const priorState = pending.state;
    if (pending.state === "planned") {
      pending.state = "intent";
      event(job, `${pending.effect.kind} intent ${pending.key}`);
      await save(job);
    } else pending.state = "uncertain";
    try {
      if (pending.effect.kind === "push") {
        const remote = await github.metadata(job, signal);
        if (remote.head !== pending.effect.head) {
          if (priorState !== "planned")
            throw new Error("Interrupted push absent remotely; manual reconciliation required");
          await workers.push(
            job,
            pending.effect.head,
            pending.effect.branch,
            pending.head,
            signal,
            async () =>
              assertAuthority(pending.authority, await github.gate(job, pending.head, signal)),
          );
          if ((await github.metadata(job, signal)).head !== pending.effect.head)
            throw new Error("Push receipt not verified");
        }
        for (const effect of job.effects) effect.head = pending.effect.head;
        if (job.worktree) job.worktree.head = pending.effect.head;
      } else await github.apply(job, pending, signal);
      job.receipts.push({ key: pending.key, effect: pending.effect, at: Date.now() });
      job.effects = job.effects.filter((e) => e.key !== pending.key);
      event(job, `${pending.effect.kind} receipt ${pending.key}`);
    } catch (error) {
      pending.state = "uncertain";
      await save(job);
      throw error;
    }
  }
  async function handleResult(job: Job, signal: AbortSignal): Promise<void> {
    const run = job.run;
    if (!run || run.state !== "finished" || !run.result || !job.observation) return;
    const work = run.work;
    const result = run.result;
    const current = await github.gate(job, work.head, signal);
    assertAuthority(work.threads, current);
    run.state = "handled";
    job.handled.push(work.key);
    let committed: string | null = null;
    if (work.kind === "repair") {
      for (const thread of work.threads) job.handled.push(digest(["repair", work.head, thread]));
      if (work.failing.length) job.handled.push(digest(["ci", work.head, work.failing]));
      job.fatal = "Interrupted local publication requires manual reconciliation";
      await save(job);
      if (result.ci === "blocked" || result.threads.some((t) => t.verdict === "ask"))
        throw new Error("Worker escalated repair; owned changes retained");
      committed = await workers.commit(
        job,
        signal,
        claimsSelectedFix(work, result) ? "selected-fix" : "no-fix",
      );
      if (result.threads.some((t) => t.verdict === "fix") && committed === null)
        throw new Error("Fixed verdict has no repair commit");
      if (committed)
        enqueue(
          job,
          { kind: "push", head: committed, branch: current.branch },
          work.head,
          work.threads,
        );
      job.fatal = null;
    }
    const approved: Thread[] = [];
    for (const verdict of result.threads) {
      const thread = work.threads.find((t) => t.id === verdict.id);
      if (!thread) throw new Error("Missing triaged thread");
      if (work.kind === "triage") job.handled.push(digest(["triage", work.head, thread]));
      if (work.kind === "triage" && thread.kind === "human" && verdict.verdict !== "answer") {
        reply(job, thread, verdict.reason, work.head, true, false);
      } else if (work.kind === "triage" && verdict.verdict === "fix") {
        approved.push(thread);
      } else {
        const text =
          verdict.verdict === "fix" ? `Fixed in ${committed}: ${verdict.reason}` : verdict.reason;
        reply(job, thread, text, committed ?? work.head, false, verdict.verdict !== "ask");
        if (verdict.verdict === "ask")
          job.fatal = `Review escalation ${thread.url}; ${verdict.reason}`;
      }
    }
    if (approved.length)
      job.approved = {
        head: work.head,
        threads: [...(job.approved?.head === work.head ? job.approved.threads : []), ...approved],
      };
    event(job, `${work.kind} result handled; ${result.summary}`);
    await save(job);
  }
  async function step(job: Job, signal: AbortSignal): Promise<void> {
    if (job.view.state.kind === "terminal") return;
    if (job.view.state.kind === "cleanup") {
      await cleanup(job, job.view.state.outcome, signal);
      return;
    }
    if (job.stop) {
      await cleanup(job, "stopped", signal);
      return;
    }
    await releaseScope(job.io.token);
    if (job.worker && job.worker.disposition !== "released" && job.run?.state === "intent") {
      await releaseProcess(job.worker.token);
      job.worker.disposition = "released";
      job.worker.receipt = "interrupted worker quiesced; session and edits retained";
      job.fatal =
        "Interrupted worker is not replayed; inspect retained session/worktree and stop this job";
      await save(job);
    }
    const observation = await github.observe(job, signal);
    job.observation = observation;
    job.view.observedAt = observation.observedAt;
    job.view.head = observation.head;
    job.view.verdict = observation.verdict;
    if (observation.lifecycle !== "OPEN") {
      await cleanup(job, observation.lifecycle === "MERGED" ? "merged" : "closed", signal);
      return;
    }
    if (observation.conflict) {
      job.view.state = {
        kind: "blocked",
        reason: "Conflict requires owner restack and drift sweep; monitoring remains armed",
      };
      return;
    }
    if (job.view.mode === "observe") {
      job.view.state = { kind: "watching", reason: observation.verdict };
      return;
    }
    if (observation.fork) {
      job.view.state = {
        kind: "blocked",
        reason: "Fork PR is observe-only in this pilot; lifecycle monitoring remains armed",
      };
      return;
    }
    const pending = job.effects[0];
    if (pending) {
      await applyEffect(job, pending, signal);
      job.view.wakeAt = Date.now();
      return;
    }
    if (job.fatal) {
      job.view.state = { kind: "blocked", reason: job.fatal };
      return;
    }
    if (job.run?.state === "finished") {
      await handleResult(job, signal);
      job.view.wakeAt = Date.now();
      return;
    }
    for (const thread of observation.threads.filter(
      (t) => t.kind === "human" && t.decision === "skip",
    ))
      reply(
        job,
        thread,
        "The author declined this change. Leaving the code as is.",
        observation.head,
        false,
        true,
      );
    if (job.effects.length) {
      job.view.wakeAt = Date.now();
      return;
    }
    const work = chooseWork(job, observation);
    if (!work) {
      job.view.state = {
        kind: "watching",
        reason: observation.threads.some((t) => t.decision === "pending")
          ? "waiting for author reactions; no code gate crossed"
          : observation.verdict,
      };
      return;
    }
    if (job.view.runs >= job.view.maxRuns) {
      job.view.state = {
        kind: "blocked",
        reason: "Worker budget exhausted; lifecycle monitoring remains armed",
      };
      return;
    }
    if (!job.worktree) {
      job.worktree = { path: workers.path(job.view.id), state: "intent", head: work.head };
      event(job, "owned worktree intent recorded");
      await save(job);
    }
    if (job.worktree.state === "intent") {
      await workers.create(job, work.head, signal);
      job.worktree.state = "ready";
      await save(job);
    }
    await workers.prepare(job, work.head, signal);
    assertAuthority(work.threads, await github.gate(job, work.head, signal));
    const evidence = await github.evidence(job, work, signal);
    if (job.worker)
      job.archive.push({
        kind: "worker",
        handle: job.worker.token,
        disposition: job.worker.disposition,
        receipt: job.worker.receipt,
      });
    if (job.run)
      job.archive.push({
        kind: "session",
        handle: job.run.session,
        disposition: "retained",
        receipt: job.run.state,
      });
    job.view.runs++;
    job.worker = {
      token: randomBytes(24).toString("hex"),
      disposition: "intent",
      receipt: "registered before spawn",
    };
    job.run = {
      work,
      state: "intent",
      result: null,
      session: workers.session(job.view.id, job.view.runs),
    };
    job.view.state = {
      kind: "working",
      reason: `${work.kind} worker; bug-fix policy; run ${job.view.runs}`,
    };
    event(job, `${work.kind} intent ${work.key}`);
    await save(job);
    job.worker.disposition = "running";
    await save(job);
    const lifecycle = new AbortController();
    const workerSignal = AbortSignal.any([signal, lifecycle.signal]);
    const monitoring = (async () => {
      while (!workerSignal.aborted) {
        try {
          await delay(config.intervalMs, undefined, { signal: workerSignal });
          assertAuthority(work.threads, await github.gate(job, work.head, workerSignal));
        } catch {
          lifecycle.abort();
          return;
        }
      }
    })();
    try {
      job.run.result = await workers.execute(job, work, evidence, workerSignal, async () =>
        assertAuthority(work.threads, await github.gate(job, work.head, workerSignal)),
      );
      job.run.state = "finished";
      job.worker.disposition = "released";
      job.worker.receipt = "worker exited; registered descendants absent";
      job.view.wakeAt = Date.now();
      event(job, `${work.kind} worker finished`);
      await save(job);
    } catch (error) {
      job.fatal =
        "Worker failed or was interrupted; retained changes require manual reconciliation";
      await save(job);
      throw error;
    } finally {
      lifecycle.abort();
      await monitoring;
    }
  }
  const task = defineTask<{ id: string }, Checkpoint, string>({
    name: "dstack.pr",
    version: 1,
    initial: () => ({ phase: "tick", iteration: 0 }),
    phases: {
      tick: async (task, runtime, ctx) => {
        const wake = new AbortController();
        active.set(task.input.id, wake);
        const signal = AbortSignal.any([runtime.signal, wake.signal]);
        let job = await get(task.input.id);
        try {
          if (job.view.wakeAt > Date.now()) {
            try {
              await delay(job.view.wakeAt - Date.now(), undefined, { signal });
            } catch {
              runtime.signal.throwIfAborted();
            }
          }
          job = await get(task.input.id);
          const operationSignal = job.stop ? runtime.signal : signal;
          job.view.wakeAt = Date.now() + config.intervalMs;
          await step(job, operationSignal);
          job.failures = 0;
        } catch (error) {
          runtime.signal.throwIfAborted();
          job.failures++;
          const reason = error instanceof Error ? error.message : "Job operation failed";
          job.view.wakeAt =
            Date.now() + Math.min(300_000, config.intervalMs * 2 ** Math.min(job.failures, 8));
          if (job.view.state.kind !== "cleanup") job.view.state = { kind: "blocked", reason };
          else job.view.state.reason = reason;
          event(job, `delayed: ${reason}`);
        } finally {
          active.delete(task.input.id);
          try {
            await releaseScope(job.io.token);
          } catch {
            const reason = "Observer/effect scope release is unverified; cleanup remains armed";
            job.view.state =
              job.view.state.kind === "cleanup" || job.view.state.kind === "terminal"
                ? { kind: "cleanup", outcome: job.view.state.outcome, reason }
                : { kind: "blocked", reason };
            job.view.wakeAt = Date.now() + config.intervalMs;
            event(job, reason);
          }
        }
        await save(job);
        await runtime.commit(
          () =>
            job.view.state.kind === "terminal"
              ? {
                  status: "terminal",
                  outcome: { status: "completed", result: job.view.state.outcome },
                }
              : {
                  status: "running",
                  checkpoint: { phase: "tick", iteration: task.state.checkpoint.iteration + 1 },
                },
          ctx,
        );
      },
    },
    abort: async (task, runtime, ctx) => {
      const job = await get(task.input.id);
      job.stop = true;
      await cleanup(job, "stopped", runtime.signal);
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", result: "stopped" } }),
        ctx,
      );
    },
  });
  const registry = createRegistry();
  registry.install({ name: "dstack", tasks: [task] });
  harness = await Harness.open(
    await openNodeSqliteStorage(join(config.stateDir, "jobs.sqlite")),
    { models: createModels(), registry },
    context,
  );
  const root = await harness.root(context);
  await harness.commit(async (tx) => {
    await tx.doc(Jobs);
  }, context);
  harness.resume();
  return {
    async request(input: JobRequest): Promise<Snapshot> {
      let selected: string | null = null;
      if (input.op === "register") {
        const source = await workers.source(
          input.registration.source,
          new AbortController().signal,
        );
        selected = await root.commit(async (tx) => {
          const store = await tx.doc(Jobs);
          const duplicate = Object.values(store.jobs).find(
            (j) =>
              j.view.repo.toLowerCase() === input.registration.repo.toLowerCase() &&
              j.view.pr === input.registration.pr &&
              j.view.state.kind !== "terminal",
          );
          if (duplicate) {
            if (duplicate.view.mode !== input.registration.mode || duplicate.view.source !== source)
              throw new Error(
                "Active registration differs; stop it before changing mode or checkout",
              );
            return duplicate.view.id;
          }
          const id = randomBytes(12).toString("hex");
          store.jobs[id] = freshJob(
            id,
            { ...input.registration, source },
            Date.now(),
            config.maxRuns,
          );
          await tx.createTask(
            task,
            { id },
            { ownership: { kind: "conversation" }, background: true },
          );
          return id;
        }, context);
      } else if (input.op === "stop") {
        await harness.commit(async (tx) => {
          const job = (await tx.doc(Jobs)).jobs[input.id];
          if (!job) throw new Error("Unknown job");
          if (job.view.state.kind !== "terminal") {
            job.stop = true;
            job.view.wakeAt = Date.now();
            job.view.state = {
              kind: "cleanup",
              outcome: "stopped",
              reason: "stop admitted; releasing owned resources",
            };
          }
        }, context);
        active.get(input.id)?.abort();
        selected = input.id;
      } else if (input.op === "status") selected = input.id;
      const store = await harness.snapshot(Jobs, context);
      const jobs = Object.values(store?.jobs ?? {})
        .filter((j) => selected === null || j.view.id === selected)
        .map(publicView);
      if (selected !== null && !jobs.length) throw new Error("Unknown job");
      return { version: 1, now: Date.now(), jobs };
    },
    async close(): Promise<void> {
      await harness.close(context);
    },
  };
}
export type Controller = Awaited<ReturnType<typeof openController>>;
