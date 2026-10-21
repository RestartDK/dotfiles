import { array, record, string } from "../../../config/pi/agent/lib/dstack-jobs.js";
import {
  assertAuthority,
  parseMetadata,
  parseObserver,
  type Job,
  type Observation,
  type PendingEffect,
  type Work,
  type WorkEvidence,
} from "./domain.js";
import { run, type Command } from "./process.js";

export type GithubConfig = {
  gh: Command;
  observer: Command;
  env: NodeJS.ProcessEnv;
  observationMs: number;
};
export class Github {
  constructor(private readonly config: GithubConfig) {}
  async api(job: Job, args: string[], signal: AbortSignal, input?: unknown): Promise<unknown> {
    const output = await run(this.config.gh, args, {
      cwd: job.view.source,
      signal,
      timeoutMs: this.config.observationMs,
      env: this.config.env,
      scope: job.io.token,
      ...(input === undefined ? {} : { input: JSON.stringify(input) }),
    });
    const parsed: unknown = JSON.parse(output || "{}");
    if (typeof parsed === "object" && parsed !== null && "errors" in parsed)
      throw new Error("GitHub GraphQL rejected the request");
    return parsed;
  }
  async metadata(job: Job, signal: AbortSignal) {
    return parseMetadata(
      await this.api(
        job,
        [
          "pr",
          "view",
          String(job.view.pr),
          "--repo",
          job.view.repo,
          "--json",
          "headRefOid,headRefName,state,mergeable,author,isCrossRepository",
        ],
        signal,
      ),
    );
  }
  async observe(job: Job, signal: AbortSignal): Promise<Observation> {
    const before = await this.metadata(job, signal);
    if (before.lifecycle !== "OPEN")
      return {
        ...before,
        verdict: before.lifecycle,
        failing: [],
        threads: [],
        resolvedThreads: [],
        observedAt: Date.now(),
      };
    const agent = string(record(await this.api(job, ["api", "user"], signal)).login);
    const output = await run(
      this.config.observer,
      [
        String(job.view.pr),
        "--repo",
        job.view.repo,
        "--me",
        before.author,
        "--agent-login",
        agent,
        "--status-only",
      ],
      {
        cwd: job.view.source,
        signal,
        timeoutMs: this.config.observationMs,
        env: this.config.env,
        scope: job.io.token,
      },
    );
    const observation = parseObserver(JSON.parse(output));
    const after = await this.metadata(job, signal);
    if (
      before.head !== after.head ||
      before.lifecycle !== after.lifecycle ||
      observation.verdict === "MERGED" ||
      observation.verdict === "CLOSED"
    )
      throw new Error("PR changed during observation");
    return {
      ...observation,
      ...after,
      conflict: after.conflict || observation.verdict === "CONFLICT",
      observedAt: Date.now(),
    };
  }
  async gate(job: Job, head: string, signal: AbortSignal): Promise<Observation> {
    const observed = await this.observe(job, signal);
    if (observed.lifecycle !== "OPEN" || observed.head !== head || observed.conflict || job.stop)
      throw new Error("Fresh PR lifecycle/revision gate rejected write");
    return observed;
  }
  private async graphql(
    job: Job,
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = record(
      await this.api(job, ["api", "graphql", "--input", "-"], signal, { query, variables }),
    );
    return record(response.data);
  }
  private async thread(
    job: Job,
    id: string,
    signal: AbortSignal,
  ): Promise<{ resolved: boolean; bodies: string[] }> {
    const data = await this.graphql(
      job,
      "query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved comments(last:100){pageInfo{hasPreviousPage} nodes{body}}}}}",
      { id },
      signal,
    );
    const node = record(data.node);
    const comments = record(node.comments);
    if (record(comments.pageInfo).hasPreviousPage !== false)
      throw new Error("Review receipt pagination limit reached");
    if (typeof node.isResolved !== "boolean") throw new Error("Missing review thread");
    return {
      resolved: node.isResolved,
      bodies: array(comments.nodes).map((v) => string(record(v).body)),
    };
  }
  async evidence(job: Job, work: Work, signal: AbortSignal): Promise<WorkEvidence> {
    const threads: WorkEvidence["threads"] = [];
    for (const thread of work.threads) {
      const full = await this.thread(job, thread.id, signal);
      if (full.resolved) throw new Error("Review changed before dispatch");
      if (full.bodies.some((body) => body.length > 16000))
        throw new Error("Review evidence exceeds worker limit; manual triage required");
      threads.push({ id: thread.id, comments: full.bodies });
    }
    const ciLogs: string[] = [];
    if (work.failing.length) {
      const checks = record(
        await this.api(
          job,
          [
            "pr",
            "view",
            String(job.view.pr),
            "--repo",
            job.view.repo,
            "--json",
            "statusCheckRollup",
          ],
          signal,
        ),
      );
      const runs = new Set<string>();
      const covered = new Set<string>();
      for (const raw of array(checks.statusCheckRollup)) {
        const check = record(raw);
        const name = string(check.name ?? check.context);
        if (!work.failing.includes(name)) continue;
        if (typeof check.detailsUrl !== "string")
          throw new Error(`CI logs unavailable for ${name}; manual classification required`);
        const url = new URL(check.detailsUrl);
        const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/([0-9]+)(?:\/|$)/);
        if (
          url.hostname !== "github.com" ||
          match?.[1]?.toLowerCase() !== job.view.repo.toLowerCase() ||
          !match[2]
        )
          throw new Error(`CI logs unavailable for ${name}; manual classification required`);
        runs.add(match[2]);
        covered.add(name);
      }
      if (work.failing.some((name) => !covered.has(name)) || runs.size === 0 || runs.size > 5)
        throw new Error(
          "CI logs unavailable or too many failing runs; manual classification required",
        );
      for (const id of runs) {
        const log = await run(
          this.config.gh,
          ["run", "view", id, "--repo", job.view.repo, "--log-failed"],
          {
            cwd: job.view.source,
            signal,
            timeoutMs: this.config.observationMs,
            env: this.config.env,
            scope: job.io.token,
          },
        );
        if (!log.trim())
          throw new Error(`CI logs unavailable for run ${id}; manual classification required`);
        if (log.length > 64000)
          throw new Error(
            `CI evidence exceeds worker limit for run ${id}; manual classification required`,
          );
        ciLogs.push(log);
      }
    }
    return { threads, ciLogs };
  }
  async apply(job: Job, pending: PendingEffect, signal: AbortSignal): Promise<void> {
    const effect = pending.effect;
    if (effect.kind === "push") throw new Error("Git owns push effects");
    const authorize = async () => {
      const observed = await this.gate(job, pending.head, signal);
      assertAuthority(pending.authority, observed);
      return observed;
    };
    switch (effect.kind) {
      case "reply": {
        const thread = await this.thread(job, effect.thread, signal);
        if (thread.bodies.some((body) => body.includes(`<!-- dstack:${effect.marker} -->`))) return;
        if (pending.state === "uncertain")
          throw new Error("Uncertain reply absent remotely; manual reconciliation required");
        const observed = await authorize();
        if (!observed.threads.some((t) => t.id === effect.thread))
          throw new Error("Review thread no longer actionable");
        await this.graphql(
          job,
          "mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}",
          { thread: effect.thread, body: effect.body },
          signal,
        );
        return;
      }
      case "resolve": {
        if ((await this.thread(job, effect.thread, signal)).resolved) return;
        if (pending.state === "uncertain")
          throw new Error(
            "Uncertain resolution absent remotely; deliberate reopening is not replayed",
          );
        await authorize();
        await this.graphql(
          job,
          "mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}",
          { thread: effect.thread },
          signal,
        );
        if (!(await this.thread(job, effect.thread, signal)).resolved)
          throw new Error("Review resolution not verified");
        return;
      }
      case "review": {
        const endpoint = `repos/${job.view.repo}/pulls/${job.view.pr}/requested_reviewers`;
        if (!effect.bot) {
          const reviewers = record(await this.api(job, ["api", endpoint], signal));
          if (array(reviewers.users).some((v) => record(v).login === effect.reviewer)) return;
          if (pending.state === "uncertain")
            throw new Error("Uncertain review request; manual reconciliation required");
          await authorize();
          await this.api(job, ["api", endpoint, "--method", "POST", "--input", "-"], signal, {
            reviewers: [effect.reviewer],
          });
          return;
        }
        const commentsEndpoint = `repos/${job.view.repo}/issues/${job.view.pr}/comments`;
        const comments = array(
          await this.api(job, ["api", `${commentsEndpoint}?per_page=100`], signal),
        );
        if (
          comments.some((v) => string(record(v).body).includes(`<!-- dstack:${effect.marker} -->`))
        )
          return;
        if (comments.length >= 100 || pending.state === "uncertain")
          throw new Error("Cannot safely repeat bot re-review request");
        await authorize();
        await this.api(job, ["api", commentsEndpoint, "--method", "POST", "--input", "-"], signal, {
          body: effect.body,
        });
        return;
      }
    }
  }
}
