import { expect, test } from "bun:test";
import {
  assertAuthority,
  chooseWork,
  claimsSelectedFix,
  digest,
  freshJob,
  parseObserver,
  type Observation,
  type Thread,
  type Work,
  type WorkerResult,
} from "../src/domain.ts";

const thread = (extra: Partial<Thread> = {}): Thread => ({
  id: "T1",
  kind: "human",
  decision: "implement",
  author: "reviewer",
  url: "https://github.com/a/b/pull/1#discussion_r1",
  body: "Fix the parser",
  direction: "",
  generation: digest(["original"]),
  approval: digest(["author", "+1", "gate1"]),
  ...extra,
});
const observation = (threads: Thread[], resolvedThreads: Thread[] = []): Observation => ({
  head: "a".repeat(40),
  branch: "repair",
  author: "daniel",
  lifecycle: "OPEN",
  verdict: "THREADS",
  conflict: false,
  fork: false,
  failing: [],
  threads,
  resolvedThreads,
  observedAt: 1,
});
const job = () =>
  freshJob("a".repeat(24), { repo: "a/b", pr: 1, source: "/tmp/source", mode: "drive" }, 0, 4);

test("selected authority rejects revoked votes, changed discussion, new direction and vanished threads", () => {
  const selected = thread();
  for (const changed of [
    thread({ decision: "pending", approval: digest(null) }),
    thread({ generation: digest(["original", "new reviewer finding"]) }),
    thread({
      decision: "direction",
      direction: "Leave this alone",
      approval: digest(["new direction"]),
    }),
  ])
    expect(() => assertAuthority([selected], observation([changed]))).toThrow(
      "author approval changed",
    );
  expect(() => assertAuthority([selected], observation([]))).toThrow();
  expect(() => assertAuthority([selected], observation([thread()]))).not.toThrow();
  expect(() => assertAuthority([selected], observation([], [thread()]))).not.toThrow();
});

test("human approval is bound to the exact verdict content generation", () => {
  const discussion = [
    {
      id: "review1",
      author: "reviewer",
      body: "Original finding",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ];
  const raw = {
    ...thread(),
    discussion,
    gate_generation: digest(discussion),
    approval: { author: "daniel", gate: "gate1", vote: "+1" },
  };
  const parse = (value: unknown) =>
    parseObserver({
      complete: true,
      verdict: "THREADS",
      failing_checks: [],
      resolved_threads: [],
      threads: [value],
    }).threads[0]?.decision;
  expect(parse(raw)).toBe("implement");
  expect(parse({ ...raw, discussion: [{ ...discussion[0], body: "Edited finding" }] })).toBe(
    "unanswered",
  );
  expect(parse({ ...raw, discussion: [] })).toBe("unanswered");
  expect(parse({ ...raw, gate_generation: undefined })).toBe("unanswered");
  expect(
    parse({ ...raw, discussion: [discussion[0], { id: "review2", body: "Another finding" }] }),
  ).toBe("unanswered");
});

test("new review generations cannot inherit old worker or bot-approval receipts", () => {
  const j = job();
  const original = thread({ kind: "bot" });
  j.handled.push(
    digest(["triage", "a".repeat(40), original]),
    digest(["repair", "a".repeat(40), original]),
  );
  j.approved = { head: "a".repeat(40), threads: [original] };
  expect(chooseWork(j, observation([original]))).toBeNull();
  const next = thread({ kind: "bot", generation: digest(["new finding"]) });
  expect(chooseWork(j, observation([next]))?.kind).toBe("triage");
  j.handled.push(digest(["triage", "a".repeat(40), next]));
  expect(chooseWork(j, observation([next]))).toBeNull();
});

test("publication requires an explicitly selected fix, not dirt or unrelated verdicts", () => {
  const selected = thread();
  const work: Work = {
    kind: "repair",
    key: "selected",
    head: "a".repeat(40),
    threads: [selected],
    failing: [],
  };
  const result: WorkerResult = {
    summary: "No change",
    ci: "none",
    threads: [{ id: selected.id, verdict: "dismiss", reason: "Already correct" }],
  };
  expect(claimsSelectedFix(work, result)).toBe(false);
  expect(
    claimsSelectedFix(work, {
      ...result,
      threads: [{ id: "OTHER", verdict: "fix", reason: "Unselected" }],
    }),
  ).toBe(false);
  expect(
    claimsSelectedFix(work, {
      ...result,
      threads: [{ id: selected.id, verdict: "fix", reason: "Fixed selected finding" }],
    }),
  ).toBe(true);
  expect(
    claimsSelectedFix(
      { ...work, threads: [], failing: ["build"] },
      { ...result, ci: "fixed", threads: [] },
    ),
  ).toBe(true);
});
