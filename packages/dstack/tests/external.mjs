import { appendFileSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

const root = process.env.DSTACK_FIXTURE_ROOT;
if (!root) throw new Error("Fixture root missing");
const statePath = join(root, "github.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const [kind, ...args] = process.argv.slice(2);
const readInput = async () => {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
};
const save = () => {
  writeFileSync(`${statePath}.next`, JSON.stringify(state));
  renameSync(`${statePath}.next`, statePath);
};
const output = (value) => console.log(JSON.stringify(value));
const observed = (thread) => ({
  ...thread,
  discussion: thread.discussion || [thread.body],
  gate_generation: createHash("sha256")
    .update(JSON.stringify(thread.discussion || [thread.body]))
    .digest("hex")
    .slice(0, 32),
  approval:
    thread.decision === "implement" || thread.decision === "direction"
      ? { decision: thread.decision, direction: thread.direction }
      : null,
});
const head = () =>
  execFileSync("git", ["--git-dir", join(root, "remote"), "rev-parse", "refs/heads/repair"], {
    encoding: "utf8",
  }).trim();
if (kind === "pi") {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const task = JSON.parse(prompt.split("\n").at(-1));
  appendFileSync(
    join(root, "workers.jsonl"),
    `${JSON.stringify({ ...task, pid: process.pid, token: process.env.DSTACK_PROCESS_TOKEN })}\n`,
  );
  if (state.hangWorker) {
    setInterval(() => {}, 1000);
  } else {
    if (task.operation === "repair") writeFileSync("app.txt", "fixed\n");
    const answer = {
      summary: "Fixture repair; production process and git path exercised",
      ci: task.failingChecks.length ? "fixed" : "none",
      threads: task.threads.map((thread) => ({
        id: thread.id,
        verdict: state.verdicts?.[thread.id] ?? "fix",
        reason: "app.txt has the demonstrated defect",
      })),
    };
    const expected = process.env.DSTACK_EXPECTED_MODEL;
    const slash = expected.indexOf("/");
    output({
      type: "message_end",
      message: {
        role: "assistant",
        provider: expected.slice(0, slash),
        model: expected.slice(slash + 1),
        stopReason: "stop",
        content: [{ type: "text", text: JSON.stringify(answer) }],
      },
    });
    output({ type: "agent_settled" });
  }
} else if (state.offline) {
  process.exitCode = 1;
} else if (kind === "observer") {
  const repaired =
    execFileSync("git", ["--git-dir", join(root, "remote"), "show", "refs/heads/repair:app.txt"], {
      encoding: "utf8",
    }).trim() === "fixed";
  const failing = repaired ? [] : state.failing;
  output({
    verdict: state.conflict
      ? "CONFLICT"
      : failing.length
        ? "CI_FAIL"
        : state.threads.length
          ? "THREADS"
          : "READY",
    complete: true,
    failing_checks: failing,
    threads: state.threads.filter((t) => !state.resolved.includes(t.id)).map(observed),
    resolved_threads: state.threads.filter((t) => state.resolved.includes(t.id)).map(observed),
  });
} else if (kind === "gh" && args[0] === "api" && args[1] === "user") {
  output({ login: "daniel" });
} else if (kind === "gh" && args[0] === "run") {
  console.log(state.ciLog ?? "app.txt expected fixed but received broken");
} else if (kind === "gh" && args.includes("statusCheckRollup")) {
  output({
    statusCheckRollup: state.checks ?? [
      { name: "build", detailsUrl: "https://github.com/a/b/actions/runs/123/job/456" },
    ],
  });
} else if (kind === "gh" && args[0] === "pr") {
  output({
    headRefOid: head(),
    headRefName: "repair",
    state: state.lifecycle,
    mergeable: state.conflict ? "CONFLICTING" : "MERGEABLE",
    author: { login: "daniel" },
    isCrossRepository: false,
  });
} else if (kind === "gh" && args[1] === "graphql") {
  const { query, variables } = await readInput();
  if (query.startsWith("query")) {
    output({
      data: {
        node: {
          isResolved: state.resolved.includes(variables.id),
          comments: {
            pageInfo: { hasPreviousPage: false },
            nodes: [
              ...state.threads.filter((t) => t.id === variables.id).map((t) => ({ body: t.body })),
              ...state.comments
                .filter((c) => c.thread === variables.id)
                .map((c) => ({ body: c.body })),
            ],
          },
        },
      },
    });
  } else if (query.includes("addPullRequestReviewThreadReply")) {
    state.comments.push({ thread: variables.thread, body: variables.body });
    const thread = state.threads.find((t) => t.id === variables.thread);
    if (
      thread &&
      variables.body.endsWith(
        "Checking with the author before changing anything: thumbs up to implement, thumbs down to leave as is, or reply with direction.",
      )
    )
      thread.decision = "pending";
    save();
    if (state.failAfterReply) process.exitCode = 1;
    else
      output({
        data: { addPullRequestReviewThreadReply: { comment: { id: `C${state.comments.length}` } } },
      });
  } else if (query.includes("resolveReviewThread")) {
    if (!state.resolved.includes(variables.thread)) state.resolved.push(variables.thread);
    save();
    output({
      data: { resolveReviewThread: { thread: { id: variables.thread, isResolved: true } } },
    });
  } else throw new Error("Unexpected GraphQL");
} else if (kind === "gh" && args[1]?.includes("requested_reviewers")) {
  if (args.includes("POST")) {
    const body = await readInput();
    state.reviewers.push(...body.reviewers);
    state.reviewRequests++;
    save();
  }
  output({ users: state.reviewers.map((login) => ({ login })) });
} else if (kind === "gh" && args[1]?.includes("/comments")) {
  if (args.includes("POST")) {
    const body = await readInput();
    state.issueComments.push(body);
    save();
    output(body);
  } else output(state.issueComments);
} else throw new Error("Unexpected fixture call");
