import { afterEach, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, watch } from "node:fs";
import { mkdtemp, mkdir, readFile, stat, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freezeOutcome,
  OUTCOME_ENTRY,
  OutcomeQueue,
  outcomeStatus,
  parseContract,
  parseObservation,
  parseOutcome,
  parseOutcomeAction,
  proveOutcome,
  restoreOutcome,
  type Contract,
  type Expectation,
} from "./outcome.ts";
import { runProcess, type ProcessResult } from "./outcome-runner.ts";
import { OutcomeWorkflow } from "./outcome-workflow.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "outcome-"));
  temporary.push(root);
  const workspace = join(root, "workspace");
  const store = join(root, "private");
  await mkdir(workspace);
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "actual.json"), '{"answer":42}');
  await writeFile(
    join(workspace, "checker.cjs"),
    `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const actual = JSON.parse(fs.readFileSync('src/actual.json', 'utf8'));
assert.equal(actual.answer, 42);
process.stdout.write(JSON.stringify({kind:'text', value:'answer is 42'}));
`,
  );
  const contract: Contract = {
    request: "Reading the implementation returns answer 42",
    scope: "Local JSON answer only. No deployment claim.",
    inputs: ["src"],
    targets: ["src/actual.json"],
    criteria: [
      {
        id: "answer",
        claim: "Reads the actual target and asserts its answer",
        command: [process.execPath, "checker.cjs"],
        verifierInputs: ["checker.cjs"],
        timeoutMs: 5000,
        expect: { kind: "equals", value: "answer is 42" },
      },
    ],
  };
  const outcome = await freezeOutcome(
    { version: 1, kind: "empty" },
    { action: "begin", contract },
    workspace,
  );
  return { root, workspace, store, contract, outcome };
}

test("actual implementation execution is required, logs stay private, and a failed assertion cannot verify", async () => {
  const f = await fixture();
  expect((await outcomeStatus(f.outcome, f.workspace, f.store)).kind).toBe("not-verified");
  const proved = await proveOutcome(f.outcome, undefined, f.store);
  expect(await outcomeStatus(proved, f.workspace, f.store)).toMatchObject({
    kind: "verified",
    coverage: ["answer"],
  });
  if (proved.attempt.kind !== "receipt") throw new Error("Expected receipt");
  const id = proved.attempt.id;
  expect((await stat(f.store)).mode & 0o777).toBe(0o700);
  for (const suffix of [".json", "-answer.stdout", "-answer.stderr"])
    expect((await stat(join(f.store, `${id}${suffix}`))).mode & 0o777).toBe(0o600);
  await writeFile(join(f.workspace, "src", "actual.json"), '{"answer":41}');
  const failed = await proveOutcome(f.outcome, undefined, f.store);
  expect((await outcomeStatus(failed, f.workspace, f.store)).kind).toBe("not-verified");
  if (failed.attempt.kind !== "receipt") throw new Error("Expected failure receipt");
  expect(await readFile(join(f.store, `${failed.attempt.id}-answer.stderr`), "utf8")).toContain(
    "AssertionError",
  );
});

test("changed dirty bytes, new untracked relevant files, wrong workspace, and amendments invalidate proof", async () => {
  const f = await fixture();
  const proved = await proveOutcome(f.outcome, undefined, f.store);
  await writeFile(join(f.workspace, "src", "extra.json"), "new untracked input");
  expect(await outcomeStatus(proved, f.workspace, f.store)).toMatchObject({
    kind: "not-verified",
    reason: { kind: "stale-inputs" },
  });
  const refreshed = await proveOutcome(f.outcome, undefined, f.store);
  await writeFile(join(f.workspace, "src", "actual.json"), '{"answer":42,"dirty":true}');
  expect((await outcomeStatus(refreshed, f.workspace, f.store)).kind).toBe("not-verified");
  expect((await outcomeStatus(refreshed, f.root, f.store)).kind).toBe("not-verified");
  const amended = await freezeOutcome(
    proved,
    { action: "amend", contract: { ...f.contract, scope: "Changed scope" } },
    f.workspace,
  );
  expect(amended.revision).toBe(2);
  expect((await outcomeStatus(amended, f.workspace, f.store)).kind).toBe("not-verified");
});

test("a checker changed after freeze cannot execute as the old verifier", async () => {
  const f = await fixture();
  const proved = await proveOutcome(f.outcome, undefined, f.store);
  await writeFile(join(f.workspace, "checker.cjs"), "process.exit(0)");
  expect((await outcomeStatus(proved, f.workspace, f.store)).kind).toBe("not-verified");
  await expect(proveOutcome(f.outcome, undefined, f.store)).rejects.toThrow(
    "Frozen verifier changed",
  );
});

test("malformed saved receipts, log tampering, and missing coverage never manufacture verification", async () => {
  const f = await fixture();
  const proved = await proveOutcome(f.outcome, undefined, f.store);
  if (proved.attempt.kind !== "receipt") throw new Error("Expected receipt");
  const receiptPath = join(f.store, `${proved.attempt.id}.json`);
  const original = await readFile(receiptPath, "utf8");
  await writeFile(receiptPath, '{"version":1,"checks":[],"passed":true}');
  await expect(outcomeStatus(proved, f.workspace, f.store)).rejects.toThrow();
  const raw: unknown = JSON.parse(original);
  if (typeof raw !== "object" || raw === null) throw new Error("Expected receipt object");
  await writeFile(receiptPath, JSON.stringify({ ...raw, checks: [] }));
  expect((await outcomeStatus(proved, f.workspace, f.store)).kind).toBe("not-verified");
  await writeFile(receiptPath, original);
  await writeFile(
    join(f.store, `${proved.attempt.id}-answer.stdout`),
    '{"kind":"text","value":"forged"}',
  );
  expect((await outcomeStatus(proved, f.workspace, f.store)).kind).toBe("not-verified");
});

test("real zero-exit malformed observations, missed numeric targets and cancelled proofs remain unverified", async () => {
  const f = await fixture();
  for (const [index, script] of [
    "process.stdout.write(JSON.stringify({kind:'metric',value:25}))",
    "process.stdout.write(JSON.stringify({passed:true}))",
    "setInterval(()=>{},1000)",
    "process.stdout.write(JSON.stringify({kind:'metric',value:20}))",
  ].entries()) {
    const contract: Contract = {
      ...f.contract,
      criteria: f.contract.criteria.map((criterion) => ({
        ...criterion,
        command: [process.execPath, "-e", script],
        timeoutMs: index === 2 ? 20 : 5000,
        expect: { kind: "metric", baseline: 30, direction: "lower", target: 20, unit: "ms" },
      })),
    };
    const frozen = await freezeOutcome(f.outcome, { action: "amend", contract }, f.workspace);
    const proved = await proveOutcome(frozen, undefined, f.store);
    if (index === 1) await expect(outcomeStatus(proved, f.workspace, f.store)).rejects.toThrow();
    else
      expect((await outcomeStatus(proved, f.workspace, f.store)).kind).toBe(
        index === 3 ? "verified" : "not-verified",
      );
  }
  const abort = new AbortController();
  abort.abort();
  const cancelled = await proveOutcome(f.outcome, abort.signal, f.store);
  expect(await outcomeStatus(cancelled, f.workspace, f.store)).toMatchObject({
    kind: "not-verified",
    reason: { kind: "cancelled" },
  });
});

test("contract and observation boundaries reject untyped success claims and invalid metric targets", async () => {
  const f = await fixture();
  for (const criteria of [
    [],
    [{ ...f.contract.criteria[0], id: "../escape" }],
    [
      {
        ...f.contract.criteria[0],
        expect: { kind: "metric", baseline: 10, target: 11, direction: "lower", unit: "ms" },
      },
    ],
  ])
    expect(() => parseContract({ ...f.contract, criteria })).toThrow();
  for (const observation of [
    '{"passed":true}',
    '{"kind":"text","value":"ok","passed":true}',
    "not JSON",
    '{"kind":"metric","value":"2"}',
  ])
    expect(() => parseObservation(observation)).toThrow();
  expect(() => parseOutcomeAction({ action: "verify", passed: true })).toThrow();
  expect(() =>
    parseOutcome({ ...f.outcome, contract: { ...f.contract, request: "changed" } }),
  ).toThrow();
  expect(() =>
    parseOutcome({ ...f.outcome, attempt: { kind: "receipt", id: "../../escape" } }),
  ).toThrow();
});

test.each([
  {
    expected: { kind: "equals", value: "answer is 42" },
    stdout: '{"kind":"text","value":"answer is 42"}',
  },
  {
    expected: { kind: "metric", baseline: 30, direction: "lower", target: 20, unit: "ms" },
    stdout: '{"kind":"metric","value":20}',
  },
] satisfies { expected: Expectation; stdout: string }[])(
  "contract key order preserves saved proof while semantic changes invalidate identity (%#)",
  async ({ expected, stdout }) => {
    const f = await fixture();
    const contract: Contract = {
      ...f.contract,
      criteria: f.contract.criteria.map((criterion) => ({
        ...criterion,
        expect: expected,
        command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(stdout)})`],
      })),
    };
    const reordered: Contract = {
      criteria: contract.criteria.map((criterion) => ({
        expect:
          criterion.expect.kind === "equals"
            ? { value: criterion.expect.value, kind: "equals" }
            : {
                unit: criterion.expect.unit,
                direction: criterion.expect.direction,
                target: criterion.expect.target,
                baseline: criterion.expect.baseline,
                kind: "metric",
              },
        verifierInputs: criterion.verifierInputs,
        timeoutMs: criterion.timeoutMs,
        command: criterion.command,
        claim: criterion.claim,
        id: criterion.id,
      })),
      targets: contract.targets,
      inputs: contract.inputs,
      scope: contract.scope,
      request: contract.request,
    };
    const original = await freezeOutcome(
      { version: 1, kind: "empty" },
      { action: "begin", contract },
      f.workspace,
    );
    const shuffled = await freezeOutcome(
      { version: 1, kind: "empty" },
      { action: "begin", contract: reordered },
      f.workspace,
    );
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(contract));
    expect(shuffled.digest).toBe(original.digest);
    const proved = await proveOutcome(original, undefined, f.store);
    const saved: unknown = JSON.parse(JSON.stringify({ ...proved, contract: reordered }));
    const restored = parseOutcome(saved);
    expect(await outcomeStatus(restored, f.workspace, f.store)).toMatchObject({
      kind: "verified",
      coverage: ["answer"],
    });
    const changedExpectation: Expectation =
      expected.kind === "equals"
        ? { ...expected, value: "a different answer" }
        : { ...expected, target: 19 };
    for (const changed of [
      { ...contract, request: "A different request" },
      {
        ...contract,
        criteria: contract.criteria.map((criterion) => ({ ...criterion, timeoutMs: 4000 })),
      },
      {
        ...contract,
        criteria: contract.criteria.map((criterion) => ({
          ...criterion,
          expect: changedExpectation,
        })),
      },
    ]) {
      expect(() => parseOutcome({ ...proved, contract: changed })).toThrow(
        "Changed outcome contract",
      );
      const amended = await freezeOutcome(
        proved,
        { action: "amend", contract: changed },
        f.workspace,
      );
      expect(amended.digest).not.toBe(proved.digest);
      expect(await outcomeStatus(amended, f.workspace, f.store)).toMatchObject({
        kind: "not-verified",
        reason: { kind: "no-proof" },
      });
    }
  },
);

test("branch restoration ignores abandoned outcomes and clear does not resurrect prior proof", async () => {
  const f = await fixture();
  const entry = { type: "custom", customType: OUTCOME_ENTRY, data: f.outcome };
  const amendment = await freezeOutcome(
    f.outcome,
    { action: "amend", contract: f.contract },
    f.workspace,
  );
  expect(restoreOutcome([entry]).kind).toBe("active");
  expect(restoreOutcome([entry, { ...entry, data: amendment }])).toEqual(amendment);
  expect(restoreOutcome([entry])).toEqual(f.outcome);
  expect(restoreOutcome([entry, { ...entry, data: { version: 1, kind: "empty" } }])).toEqual({
    version: 1,
    kind: "empty",
  });
  expect(() => restoreOutcome([entry, { ...entry, data: { version: 999 } }])).toThrow();
});

test("the outcome queue serializes transitions and a rejection does not strand subsequent work", async () => {
  const queue = new OutcomeQueue();
  const order: number[] = [];
  const first = queue.run(async () => {
    order.push(1);
    throw new Error("first failed");
  });
  const second = queue.run(async () => {
    order.push(2);
    return "ok";
  });
  await expect(first).rejects.toThrow("first failed");
  expect(await second).toBe("ok");
  expect(order).toEqual([1, 2]);
});

test("symlinks cannot hide relevant bytes outside the declared workspace", async () => {
  const f = await fixture();
  await symlink(f.root, join(f.workspace, "src", "outside"));
  await expect(proveOutcome(f.outcome, undefined, f.store)).rejects.toThrow("symlink");
});

test("process receipts distinguish success, failure, signal, deadline, cancellation and spawn failure", async () => {
  const f = await fixture();
  const cases = [
    {
      script: "process.stdout.write('ok');process.stderr.write('detail')",
      timeoutMs: 5000,
      expected: { kind: "exit", code: 0 },
    },
    { script: "process.exit(7)", timeoutMs: 5000, expected: { kind: "exit", code: 7 } },
    {
      script: "process.kill(process.pid,'SIGTERM')",
      timeoutMs: 5000,
      expected: { kind: "signal", signal: "SIGTERM" },
    },
    { script: "setInterval(()=>{},1000)", timeoutMs: 20, expected: { kind: "timeout" } },
    {
      script: "process.stdout.write('x'.repeat(11*1024*1024));setInterval(()=>{},1000)",
      timeoutMs: 5000,
      expected: { kind: "output-limit" },
    },
  ] satisfies { script: string; timeoutMs: number; expected: ProcessResult }[];
  for (const [index, row] of cases.entries()) {
    const execution = await runProcess({
      command: [process.execPath, "-e", row.script],
      cwd: f.workspace,
      timeoutMs: row.timeoutMs,
      logPrefix: join(f.root, `process-${index}`),
    });
    expect(execution.result).toEqual(row.expected);
  }
  const abort = new AbortController();
  abort.abort();
  expect(
    (
      await runProcess({
        command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
        cwd: f.workspace,
        timeoutMs: 5000,
        signal: abort.signal,
        logPrefix: join(f.root, "cancel"),
      })
    ).result.kind,
  ).toBe("cancelled");
  expect(
    (
      await runProcess({
        command: [join(f.root, "missing-binary")],
        cwd: f.workspace,
        timeoutMs: 5000,
        logPrefix: join(f.root, "spawn"),
      })
    ).result.kind,
  ).toBe("spawn-error");
  expect(
    (
      await runProcess({
        command: [join(f.root, "missing-binary")],
        cwd: f.workspace,
        timeoutMs: 5000,
        signal: abort.signal,
        logPrefix: join(f.root, "cancel-spawn"),
      })
    ).result.kind,
  ).toBe("cancelled");
});

function beforeDeadline<T>(operation: Promise<T>, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Operation exceeded the outer deadline")),
      timeoutMs,
    );
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function fileReady(path: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`File was not ready: ${path}`)), timeoutMs);
    const watcher = watch(join(path, ".."), () => {
      if (existsSync(path)) finish();
    });
    const finish = (error?: Error) => {
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve();
    };
    watcher.on("error", finish);
    if (existsSync(path)) finish();
  });
}

test.each(["timeout", "cancelled"])(
  "workflow %s finishes while an escaped descendant still holds both captured pipes",
  async (kind) => {
    const f = await fixture();
    await writeFile(
      join(f.workspace, "descendant.cjs"),
      `
const fs = require('node:fs');
const safety = setTimeout(() => process.exit(2), 60000);
function release() {
  if (!fs.existsSync('descendant-release')) return;
  fs.unwatchFile('descendant-release', release);
  clearTimeout(safety);
  fs.writeFileSync('descendant-done', '');
}
fs.watchFile('descendant-release', { interval: 20 }, release);
fs.writeFileSync('descendant-ready', '');
release();
`,
    );
    await writeFile(
      join(f.workspace, "checker.cjs"),
      `
const fs = require('node:fs');
const child = require('node:child_process').spawn(process.execPath, ['descendant.cjs'], {
  detached: true, stdio: ['ignore', 'inherit', 'inherit']
});
fs.writeFileSync('descendant-pid', String(child.pid));
child.unref();
process.on('exit', () => fs.writeFileSync('checker-exited', ''));
`,
    );
    const contract: Contract = {
      ...f.contract,
      criteria: f.contract.criteria.map((criterion) => ({
        ...criterion,
        timeoutMs: kind === "timeout" ? 10000 : 30000,
        verifierInputs: ["checker.cjs", "descendant.cjs"],
      })),
    };
    const owner = workflowFixture(f.workspace, f.store);
    await owner.workflow.execute({ action: "begin", contract }, owner.ctx);
    const abort = new AbortController();
    const proving = owner.workflow.execute({ action: "prove" }, owner.ctx, abort.signal);
    const errors: unknown[] = [];
    try {
      await Promise.all([
        fileReady(join(f.workspace, "descendant-ready")),
        fileReady(join(f.workspace, "checker-exited")),
      ]);
      if (kind === "cancelled") abort.abort();
      const result = await beforeDeadline(proving, 15000);
      expect(result.proof).toMatchObject(
        kind === "cancelled"
          ? { kind: "not-verified", reason: { kind: "cancelled" } }
          : {
              kind: "not-verified",
              reason: { kind: "process-failed", result: { kind: "timeout" } },
            },
      );
      expect((await owner.workflow.status(owner.ctx)).proof).toEqual(result.proof);
      expect(existsSync(join(f.workspace, "descendant-done"))).toBe(false);
      const pid = Number(await readFile(join(f.workspace, "descendant-pid"), "utf8"));
      process.kill(pid, 0);
    } catch (error) {
      errors.push(error);
    } finally {
      abort.abort();
      await writeFile(join(f.workspace, "descendant-release"), "");
      try {
        if (existsSync(join(f.workspace, "descendant-pid")))
          await fileReady(join(f.workspace, "descendant-done"));
      } finally {
        if (existsSync(join(f.workspace, "descendant-pid"))) {
          const pid = Number(await readFile(join(f.workspace, "descendant-pid"), "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, "SIGKILL");
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
                errors.push(error);
            }
          }
        }
        await beforeDeadline(proving.catch(() => undefined));
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Checker regression or cleanup failed");
  },
  45000,
);

function workflowFixture(workspace: string, store: string) {
  type Entry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];
  let branch: Entry[] = [];
  let session = "original-session";
  let sequence = 0;
  let persistenceFailure: ((data: unknown) => boolean) | undefined;
  const append = (customType: string, data: unknown) => {
    branch = [
      ...branch,
      {
        type: "custom",
        customType,
        data,
        id: String(++sequence),
        parentId: branch.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
      },
    ];
    if (persistenceFailure?.(data)) throw new Error("ENOSPC: injected session persistence failure");
  };
  const workflow = new OutcomeWorkflow(append, store);
  const ctx = {
    cwd: workspace,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => session,
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
  };
  return {
    workflow,
    ctx,
    append,
    failPersistence: (when?: (data: unknown) => boolean) => {
      persistenceFailure = when;
    },
    selectSession: (id: string) => {
      session = id;
    },
    leaveBranch: () => {
      branch = branch.slice(0, -1);
    },
    switchSession: () => {
      session = "another-session";
    },
  };
}

test("only the latest outcome snapshot is parsed, while a malformed latest snapshot fails closed", async () => {
  const f = await fixture();
  const entry = (data: unknown) => ({ type: "custom", customType: OUTCOME_ENTRY, data });
  const malformed = entry({ version: 999 });
  expect(restoreOutcome([malformed, entry(f.outcome)])).toEqual(f.outcome);
  expect(
    restoreOutcome([
      malformed,
      entry({ version: 1, kind: "empty" }),
      { type: "custom", customType: "unrelated", data: { version: 999 } },
    ]),
  ).toEqual({ version: 1, kind: "empty" });
  expect(() => restoreOutcome([entry(f.outcome), malformed])).toThrow(
    "Unsupported outcome version",
  );
});

test("explicit clear recovers a malformed latest snapshot without resurrecting an older real proof", async () => {
  const f = await fixture();
  const owner = workflowFixture(f.workspace, f.store);
  await owner.workflow.execute({ action: "begin", contract: f.contract }, owner.ctx);
  expect((await owner.workflow.execute({ action: "prove" }, owner.ctx)).proof.kind).toBe(
    "verified",
  );
  owner.append(OUTCOME_ENTRY, { version: 999 });
  for (const action of [
    { action: "status" },
    { action: "prove" },
    { action: "begin", contract: f.contract },
    { action: "amend", contract: f.contract },
    { action: "block", reason: "cannot read snapshot" },
  ]) {
    await expect(owner.workflow.execute(action, owner.ctx)).rejects.toThrow(
      "Unsupported outcome version",
    );
  }
  const cleared = await owner.workflow.execute({ action: "clear" }, owner.ctx);
  expect(cleared).toMatchObject({
    current: { version: 1, kind: "empty" },
    proof: { kind: "not-verified", reason: { kind: "no-contract" } },
  });
  expect(await owner.workflow.status(owner.ctx)).toEqual(cleared);
  const reloaded = new OutcomeWorkflow(owner.append, f.store);
  expect(await reloaded.status(owner.ctx)).toEqual(cleared);
  const restarted = await reloaded.execute({ action: "begin", contract: f.contract }, owner.ctx);
  expect(restarted.proof).toMatchObject({ kind: "not-verified", reason: { kind: "no-proof" } });
});

test.each([
  "sibling append",
  "branch navigation",
  "unannounced branch navigation",
  "navigation round trip",
  "session switch",
  "outcome cleared",
])(
  "proof publication distinguishes append-only progress from navigation (%s)",
  async (transition) => {
    const f = await fixture();
    await writeFile(
      join(f.workspace, "checker.cjs"),
      `
const assert = require('node:assert/strict');
const fs = require('node:fs');
function release() {
  if (!fs.existsSync('release')) return;
  fs.unwatchFile('release', release);
  const actual = JSON.parse(fs.readFileSync('src/actual.json', 'utf8'));
  assert.equal(actual.answer, 42);
  process.stdout.write(JSON.stringify({kind:'text', value:'answer is 42'}));
}
fs.watchFile('release', { interval: 10 }, release);
fs.writeFileSync('started', '');
release();
`,
    );
    const owner = workflowFixture(f.workspace, f.store);
    await owner.workflow.execute({ action: "begin", contract: f.contract }, owner.ctx);
    const started = fileReady(join(f.workspace, "started"), 5000);
    const proving = owner.workflow.execute({ action: "prove" }, owner.ctx);
    try {
      await started;
      switch (transition) {
        case "sibling append":
          owner.append("dstack-todos", { version: 1, plan: null, visibility: "shown" });
          owner.append("ordinary-entry", { progress: "still on the same branch" });
          break;
        case "branch navigation":
          owner.leaveBranch();
          owner.workflow.invalidate();
          break;
        case "unannounced branch navigation":
          owner.leaveBranch();
          break;
        case "outcome cleared":
          owner.append(OUTCOME_ENTRY, { version: 1, kind: "empty" });
          break;
        case "navigation round trip":
          owner.workflow.invalidate();
          owner.workflow.invalidate();
          break;
        case "session switch":
          owner.switchSession();
          break;
        default:
          throw new Error(`Unknown test transition ${transition}`);
      }
      await writeFile(join(f.workspace, "release"), "");
      if (transition === "sibling append") {
        expect((await proving).proof).toMatchObject({ kind: "verified", coverage: ["answer"] });
        expect((await owner.workflow.status(owner.ctx)).proof.kind).toBe("verified");
      } else {
        await expect(proving).rejects.toThrow(
          transition === "outcome cleared" ? "Outcome changed" : "Session branch changed",
        );
        expect((await owner.workflow.status(owner.ctx)).proof.kind).toBe("not-verified");
        const current = restoreOutcome(owner.ctx.sessionManager.getBranch());
        if (transition === "outcome cleared") expect(current.kind).toBe("empty");
        else expect(current.kind === "active" && current.attempt.kind).toBe("unproved");
      }
    } finally {
      await writeFile(join(f.workspace, "release"), "");
      await proving.catch(() => undefined);
    }
  },
  10000,
);

test("navigation also invalidates queued outcome transitions before they can write to the new branch", async () => {
  const f = await fixture();
  const owner = workflowFixture(f.workspace, f.store);
  const begin = owner.workflow.execute({ action: "begin", contract: f.contract }, owner.ctx);
  const clear = owner.workflow.execute({ action: "clear" }, owner.ctx);
  owner.workflow.invalidate();
  await expect(begin).rejects.toThrow("Session branch changed");
  await expect(clear).rejects.toThrow("Session branch changed");
  expect(owner.ctx.sessionManager.getBranch()).toEqual([]);
});

test("the workflow forwards cancellation without turning a cancelled attempt into verified proof", async () => {
  const f = await fixture();
  const owner = workflowFixture(f.workspace, f.store);
  await owner.workflow.execute({ action: "begin", contract: f.contract }, owner.ctx);
  const abort = new AbortController();
  abort.abort();
  const result = await owner.workflow.execute({ action: "prove" }, owner.ctx, abort.signal);
  expect(result.proof).toMatchObject({ kind: "not-verified", reason: { kind: "cancelled" } });
  expect((await owner.workflow.status(owner.ctx)).proof).toEqual(result.proof);
});

test("mutate-before-throw publication stays fail-closed per session until clear persists", async () => {
  const f = await fixture();
  const owner = workflowFixture(f.workspace, f.store);
  await owner.workflow.execute({ action: "begin", contract: f.contract }, owner.ctx);
  owner.failPersistence((data) => {
    const snapshot = parseOutcome(data);
    return snapshot.kind === "active" && snapshot.attempt.kind === "receipt";
  });
  await expect(owner.workflow.execute({ action: "prove" }, owner.ctx)).rejects.toThrow("ENOSPC");
  const unpublished = restoreOutcome(owner.ctx.sessionManager.getBranch());
  expect(unpublished.kind === "active" && unpublished.attempt.kind).toBe("receipt");
  await expect(new OutcomeWorkflow(owner.append, f.store).status(owner.ctx)).rejects.toThrow(
    "persistence is uncertain",
  );
  const actions = [
    { action: "status" },
    { action: "block", reason: "cannot persist" },
    { action: "begin", contract: f.contract },
    { action: "amend", contract: f.contract },
    { action: "prove" },
  ];
  for (const action of actions)
    await expect(owner.workflow.execute(action, owner.ctx)).rejects.toThrow(
      "persistence is uncertain",
    );
  owner.leaveBranch();
  owner.workflow.invalidate();
  await expect(owner.workflow.status(owner.ctx)).rejects.toThrow("persistence is uncertain");
  const other = workflowFixture(f.workspace, f.store);
  other.selectSession("another-session");
  await other.workflow.execute({ action: "begin", contract: f.contract }, other.ctx);
  await other.workflow.execute({ action: "prove" }, other.ctx);
  expect((await owner.workflow.status(other.ctx)).proof.kind).toBe("verified");
  owner.workflow.invalidate();
  await expect(owner.workflow.status(owner.ctx)).rejects.toThrow("persistence is uncertain");
  owner.failPersistence(() => true);
  await expect(owner.workflow.execute({ action: "clear" }, owner.ctx)).rejects.toThrow("ENOSPC");
  expect(restoreOutcome(owner.ctx.sessionManager.getBranch()).kind).toBe("empty");
  await expect(owner.workflow.status(owner.ctx)).rejects.toThrow("persistence is uncertain");
  owner.failPersistence();
  const cleared = await owner.workflow.execute({ action: "clear" }, owner.ctx);
  expect(cleared.proof).toMatchObject({ kind: "not-verified", reason: { kind: "no-contract" } });
  expect(await owner.workflow.status(owner.ctx)).toEqual(cleared);
  expect(await new OutcomeWorkflow(owner.append, f.store).status(owner.ctx)).toEqual(cleared);
  expect(
    (await owner.workflow.execute({ action: "begin", contract: f.contract }, owner.ctx)).proof,
  ).toMatchObject({ kind: "not-verified", reason: { kind: "no-proof" } });
});
