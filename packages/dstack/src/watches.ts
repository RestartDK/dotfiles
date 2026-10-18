import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, defineTask, type Harness } from "@earendil-works/pi-durable";
import { array, record, string } from "../../../config/pi/agent/lib/dstack-jobs.js";
import {
  watchLimits,
  type WatchRegistration,
  type WatchRequest,
  type WatchSnapshot,
  type WatchState,
  type WatchView,
} from "../../../config/pi/agent/lib/dstack-watches.js";
import { digest } from "./domain.js";
import type { GithubConfig } from "./github.js";
import { releaseScope, run } from "./process.js";

export const Watches = defineDoc<{ watches: Record<string, WatchView> }>({
  kind: "dstack.watches",
  version: 1,
  scope: "session",
  initial: () => ({ watches: {} }),
});
const context = BACKGROUND_CONTEXT;
function active(watch: WatchView): boolean {
  return ["watching", "pending", "delivering"].includes(watch.state.kind);
}
function sameRequest(watch: WatchView, input: WatchRegistration): boolean {
  const trigger =
    watch.trigger.kind === "timer"
      ? watch.trigger
      : { kind: watch.trigger.kind, repo: watch.trigger.repo, pr: watch.trigger.pr };
  return (
    JSON.stringify({
      requestId: watch.requestId,
      sessionId: watch.sessionId,
      trigger,
      deadline: watch.deadline,
      message: watch.message,
    }) === JSON.stringify(input)
  );
}
export function parseChecks(value: unknown): {
  head: string;
  total: number;
  failed: number;
  complete: boolean;
} {
  const v = record(value);
  const head = string(v.headRefOid);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error("Malformed GitHub head");
  const checks = array(v.statusCheckRollup);
  if (checks.length > 1000) throw new Error("GitHub check limit exceeded");
  let complete = checks.length > 0;
  let failed = 0;
  for (const raw of checks) {
    const check = record(raw);
    if (check.__typename === "CheckRun") {
      if (
        !["QUEUED", "IN_PROGRESS", "COMPLETED", "WAITING", "PENDING", "REQUESTED"].includes(
          string(check.status),
        )
      )
        throw new Error("Malformed CheckRun status");
      if (check.status !== "COMPLETED") {
        complete = false;
        continue;
      }
      const conclusion = string(check.conclusion);
      if (
        ![
          "SUCCESS",
          "FAILURE",
          "NEUTRAL",
          "CANCELLED",
          "SKIPPED",
          "TIMED_OUT",
          "ACTION_REQUIRED",
          "STARTUP_FAILURE",
          "STALE",
        ].includes(conclusion)
      )
        throw new Error("Malformed CheckRun conclusion");
      if (!["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) failed++;
    } else if (check.__typename === "StatusContext") {
      const state = string(check.state);
      if (!["PENDING", "EXPECTED", "SUCCESS", "FAILURE", "ERROR"].includes(state))
        throw new Error("Malformed StatusContext state");
      if (state === "PENDING" || state === "EXPECTED") complete = false;
      else if (state !== "SUCCESS") failed++;
    } else throw new Error("Malformed GitHub check type");
  }
  return { head, total: checks.length, failed, complete };
}
export function createWatchController(
  config: GithubConfig & { stateDir: string; intervalMs: number },
  owner: () => Harness,
) {
  const running = new Map<string, AbortController>();
  const admissionScope = digest(["watch-admission", config.stateDir]);
  let observers = 0;
  async function github(
    repo: string,
    pr: number,
    signal: AbortSignal,
    scope: string,
    token?: string,
  ) {
    if (observers >= 2) throw new Error("GitHub watch concurrency budget exhausted");
    observers++;
    try {
      const output = await run(
        config.gh,
        ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,statusCheckRollup"],
        {
          cwd: config.stateDir,
          signal,
          timeoutMs: Math.min(config.observationMs, 30_000),
          env: config.env,
          maxBytes: 512 * 1024,
          scope,
          token,
        },
      );
      const parsed: unknown = JSON.parse(output);
      return parseChecks(parsed);
    } finally {
      observers--;
    }
  }
  async function get(id: string): Promise<WatchView> {
    const watch = (await owner().snapshot(Watches, context))?.watches[id];
    if (!watch) throw new Error("Unknown watch");
    return structuredClone(watch);
  }
  const task = defineTask<{ id: string }, { phase: "tick"; iteration: number }, string>({
    name: "dstack.watch",
    version: 1,
    initial: () => ({ phase: "tick", iteration: 0 }),
    abort: async (task, runtime, ctx) => {
      await owner().commit(async (tx) => {
        const watch = (await tx.doc(Watches)).watches[task.input.id];
        if (watch?.state.kind === "watching")
          watch.state = { kind: "cancelled", reason: "Watch task aborted" };
      }, context);
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", result: "cancelled" } }),
        ctx,
      );
    },
    phases: {
      tick: async (task, runtime, ctx) => {
        const id = task.input.id;
        const wake = new AbortController();
        running.set(id, wake);
        const signal = AbortSignal.any([runtime.signal, wake.signal]);
        const scope = `dstack-watch:${id}`;
        let next: WatchState | undefined;
        try {
          let watch = await get(id);
          if (watch.state.kind === "watching") {
            const wait = Math.min(watch.state.nextAt, watch.deadline) - Date.now();
            if (wait > 0) await delay(wait, undefined, { signal });
            watch = await get(id);
          }
          if (watch.state.kind === "watching") {
            const observations = watch.state.observations + 1;
            if (Date.now() >= watch.deadline)
              next = { kind: "expired", reason: "Observation deadline elapsed" };
            else if (observations > watchLimits.observations)
              next = { kind: "error", reason: "Observation budget exhausted" };
            else if (watch.trigger.kind === "timer")
              next = { kind: "pending", result: { kind: "timer", at: watch.trigger.at } };
            else {
              await releaseScope(scope);
              const before = await github(watch.trigger.repo, watch.trigger.pr, signal, scope);
              if (before.head !== watch.trigger.head)
                next = { kind: "superseded", reason: "PR head changed after admission" };
              else if (before.complete) {
                const after = await github(watch.trigger.repo, watch.trigger.pr, signal, scope);
                if (after.head !== watch.trigger.head)
                  next = { kind: "superseded", reason: "PR head changed during observation" };
                else if (after.complete)
                  next = {
                    kind: "pending",
                    result: {
                      kind: "checks",
                      head: after.head,
                      total: after.total,
                      failed: after.failed,
                    },
                  };
              }
              next ??= {
                kind: "watching",
                nextAt: Date.now() + config.intervalMs,
                observations,
                error: null,
              };
            }
          }
        } catch (error) {
          runtime.signal.throwIfAborted();
          const watch = await get(id);
          if (watch.state.kind === "watching") {
            const observations = watch.state.observations + 1;
            const reason = error instanceof Error ? error.message : "Watch observation failed";
            next =
              observations >= watchLimits.observations
                ? { kind: "error", reason }
                : {
                    kind: "watching",
                    nextAt: Date.now() + Math.min(300_000, config.intervalMs * 2),
                    observations,
                    error: reason,
                  };
          }
        } finally {
          running.delete(id);
          try {
            await releaseScope(scope);
          } catch (error) {
            next = {
              kind: "error",
              reason: `Watch subprocess cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
        let terminal = false;
        await owner().commit(async (tx) => {
          const watch = (await tx.doc(Watches)).watches[id];
          if (!watch) throw new Error("Unknown watch");
          if (watch.state.kind === "watching" && next) {
            watch.state =
              Date.now() >= watch.deadline
                ? { kind: "expired", reason: "Observation deadline elapsed" }
                : next;
            watch.updatedAt = Date.now();
          }
          if (watch.state.kind === "cancelled" && next?.kind === "error")
            watch.state.reason = `Cancelled; ${next.reason}`;
          terminal = watch.state.kind !== "watching";
        }, context);
        await runtime.commit(
          () =>
            terminal
              ? { status: "terminal", outcome: { status: "completed", result: "observed" } }
              : {
                  status: "running",
                  checkpoint: { phase: "tick", iteration: task.state.checkpoint.iteration + 1 },
                },
          ctx,
        );
      },
    },
  });
  return {
    task,
    admissionScope,
    async request(input: WatchRequest): Promise<WatchSnapshot> {
      let selected: string | undefined;
      if (input.op === "create") {
        const registration = input.registration;
        const existing = Object.values(
          (await owner().snapshot(Watches, context))?.watches ?? {},
        ).find((w) => w.requestId === registration.requestId);
        if (existing) {
          if (!sameRequest(existing, registration)) throw new Error("Request ID collision");
          return { version: 1, now: Date.now(), watches: [existing] };
        }
        const now = Date.now();
        if (registration.deadline <= now || registration.deadline > now + watchLimits.lifetimeMs)
          throw new Error("Deadline must be within seven days");
        const trigger = registration.trigger;
        const pinned =
          trigger.kind === "timer"
            ? trigger
            : {
                ...trigger,
                head: (
                  await github(
                    trigger.repo,
                    trigger.pr,
                    AbortSignal.timeout(30_000),
                    admissionScope,
                    randomBytes(24).toString("hex"),
                  )
                ).head,
              };
        selected = await (
          await owner().root(context)
        ).commit(async (tx) => {
          const store = await tx.doc(Watches);
          const all = Object.values(store.watches);
          const duplicate = all.find((w) => w.requestId === registration.requestId);
          if (duplicate) {
            if (!sameRequest(duplicate, registration)) throw new Error("Request ID collision");
            return duplicate.id;
          }
          if (all.length >= watchLimits.retained || all.filter(active).length >= watchLimits.active)
            throw new Error("Watch capacity reached; retained records are never silently deleted");
          if (Date.now() >= registration.deadline)
            throw new Error("Deadline elapsed during admission");
          const id = randomBytes(12).toString("hex");
          store.watches[id] = {
            ...registration,
            trigger: pinned,
            id,
            createdAt: now,
            updatedAt: now,
            state: {
              kind: "watching",
              nextAt: pinned.kind === "timer" ? pinned.at : now,
              observations: 0,
              error: null,
            },
          };
          await tx.createTask(
            task,
            { id },
            { ownership: { kind: "conversation" }, background: true },
          );
          return id;
        }, context);
      } else if (input.op !== "list" && input.op !== "status") {
        selected = input.id;
        await owner().commit(async (tx) => {
          const store = await tx.doc(Watches);
          const watch = store.watches[input.id];
          if (!watch) throw new Error("Unknown watch");
          if (input.op === "cancel") {
            if (watch.state.kind === "delivering" || watch.state.kind === "delivered")
              throw new Error("Delivery already began; cancellation cannot retract it");
            if (active(watch))
              watch.state = { kind: "cancelled", reason: "Cancelled before delivery" };
          } else {
            if (watch.sessionId !== input.sessionId) throw new Error("Wrong target session");
            if (input.op === "begin") {
              if (watch.state.kind !== "pending")
                throw new Error("Watch is not pending; uncertain delivery must not be replayed");
              if (
                Object.values(store.watches).some(
                  (w) => w.sessionId === input.sessionId && w.state.kind === "delivering",
                )
              )
                throw new Error("Session has an outstanding delivery; reconcile its receipt first");
              watch.state = {
                kind: "delivering",
                result: watch.state.result,
                token: input.token,
                startedAt: Date.now(),
              };
            } else {
              if (
                (watch.state.kind !== "delivering" && watch.state.kind !== "delivered") ||
                watch.state.token !== input.token
              )
                throw new Error("Receipt does not match delivery claim");
              if (watch.state.kind === "delivered" && watch.state.entryId !== input.entryId)
                throw new Error("Receipt entry collision");
              watch.state = {
                kind: "delivered",
                result: watch.state.result,
                token: input.token,
                entryId: input.entryId,
              };
            }
          }
          watch.updatedAt = Date.now();
        }, context);
        if (input.op === "cancel") running.get(input.id)?.abort();
      } else if (input.op === "status") selected = input.id;
      const watches = Object.values(
        (await owner().snapshot(Watches, context))?.watches ?? {},
      ).filter(
        (w) =>
          (!selected || w.id === selected) &&
          (input.op !== "list" || !input.sessionId || input.sessionId === w.sessionId),
      );
      if (selected && watches.length === 0) throw new Error("Unknown watch");
      return { version: 1, now: Date.now(), watches };
    },
  };
}
