import assert from "node:assert/strict";
import test from "node:test";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  OUTPUT_LIMIT,
  TaskRunner,
  WriterGate,
  childEnvironment,
  consumeTask,
  forceApproval,
  ownedProcess,
  parseBinding,
  permissionHandler,
  requireSubscriptionAuth,
  resumeBinding,
  sessionId,
  taskOptions,
  zeroTotals,
  type Binding,
  type TaskServices,
} from "./core.ts";

const id = "12345678-1234-1234-1234-123456789abc";
const usage: SDKResultMessage["usage"] = {
  input_tokens: 100,
  output_tokens: 40,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 10,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: "us",
  iterations: [],
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: "standard",
  speed: "standard",
  fallback_credit: null,
};
const base = {
  type: "result",
  duration_ms: 100,
  duration_api_ms: 80,
  is_error: false,
  num_turns: 1,
  stop_reason: "end_turn",
  total_cost_usd: 0.1,
  usage,
  modelUsage: {
    fixture: {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.1,
      contextWindow: 200000,
      maxOutputTokens: 4000,
    },
  },
  permission_denials: [],
  uuid: id,
  session_id: id,
} satisfies Omit<SDKResultMessage, "subtype">;
const success = { ...base, subtype: "success", result: "done" } satisfies SDKResultMessage;
const stream = (...messages: SDKMessage[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* messages;
  },
  close() {},
});

test("auth boundary rejects logged-out, API-key, cloud and malformed status without fallback", () => {
  for (const value of [
    null,
    {},
    { loggedIn: false, authMethod: "none" },
    { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" },
    { loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" },
  ])
    assert.throws(() => requireSubscriptionAuth(value));
  requireSubscriptionAuth({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
  assert.throws(() => sessionId("../../other"));
});

test("child environment keeps own login directory but removes parent identity and alternative auth", () => {
  const source = {
    HOME: "/home/test",
    PATH: "/bin",
    CLAUDE_CONFIG_DIR: "/own",
    ANTHROPIC_API_KEY: "not-a-token",
    ANTHROPIC_AUTH_TOKEN: "not-a-token",
    CLAUDE_CODE_OAUTH_TOKEN: "not-a-token",
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_BASE_URL: "http://gateway",
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: "not-a-token",
    AWS_PROFILE: "cloud",
    HERDR_PANE_ID: "parent",
    HERDR_SOCKET_PATH: "/parent",
    CLAUDECODE: "1",
    NODE_OPTIONS: "--import /override.js",
    PI_HERDR_CLOSE_TAB: "parent",
  };
  assert.deepEqual(childEnvironment(source), {
    HOME: "/home/test",
    PATH: "/bin",
    CLAUDE_CONFIG_DIR: "/own",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_UPDATE: "1",
  });
  assert.equal(source.HERDR_PANE_ID, "parent");
});

test("permission policy ignores inherited settings and forces destructive tools through ask", async () => {
  const abort = new AbortController();
  const callback = async () => ({ behavior: "deny" as const, message: "no" });
  const options = taskOptions("/repo", "/bin/claude", {}, abort, callback);
  assert.equal(options.permissionMode, "default");
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
  assert.deepEqual(
    await forceApproval(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /repo" },
        tool_use_id: "original",
        session_id: id,
        transcript_path: "/transcript",
        cwd: "/repo",
      },
      "original",
      { signal: abort.signal },
    ),
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "Pi requires human approval.",
      },
    },
  );
});

test("approvals fail closed, omit file bodies, reject background shells, and respect cancellation", async () => {
  const abort = new AbortController();
  const descriptions: string[] = [];
  const ui = {
    hasUI: true,
    ui: {
      confirm: async (_title: string, description: string) => {
        descriptions.push(description);
        return false;
      },
    },
  };
  const handler = permissionHandler(ui, "/repo", abort.signal);
  const request = { signal: abort.signal, toolUseID: "original", requestId: "request" };
  assert.equal(
    (await handler("Write", { file_path: "/repo/a", content: "private file body" }, request))
      ?.behavior,
    "deny",
  );
  assert.deepEqual(descriptions, ["/repo\n/repo/a"]);
  assert.equal(
    (await handler("Bash", { command: "rm -rf /repo", run_in_background: true }, request))
      ?.behavior,
    "deny",
  );
  assert.equal(descriptions.length, 1);
  const noUi = permissionHandler({ ...ui, hasUI: false }, "/repo", abort.signal);
  assert.equal((await noUi("Bash", { command: "pwd" }, request))?.behavior, "deny");
  abort.abort();
  assert.equal((await handler("Edit", { file_path: "/repo/a" }, request))?.behavior, "deny");
});

test("writer lease rejects overlapping Claude and local/nested writers in both orders", () => {
  const gate = new WriterGate();
  gate.beginLocal("codemode/1");
  assert.throws(() => gate.beginClaude("task"));
  gate.endLocal("codemode/1");
  gate.beginClaude("task");
  gate.bind("task", "/canonical/repo");
  assert.throws(() => gate.beginLocal("bash/2"));
  assert.throws(() => gate.beginClaude("second"));
  gate.endClaude("wrong");
  assert.throws(() => gate.beginLocal("edit"));
  gate.endClaude("task");
  gate.beginLocal("write");
  gate.endLocal("write");
});

test("resume rejects another canonical checkout or a session absent from the active branch", () => {
  const binding: Binding = { sessionId: id, cwd: "/repo", totals: zeroTotals() };
  const branch = new Map([[id, binding]]);
  assert.equal(resumeBinding(branch, id, "/repo"), binding);
  assert.throws(() => resumeBinding(branch, id, "/other"));
  assert.throws(() => resumeBinding(new Map(), id, "/repo"));
  assert.equal(parseBinding({ ...binding, totals: { cost: NaN } }), undefined);
  assert.deepEqual(parseBinding(binding), binding);
});

test("terminal result required; SDK budget and turn failures stay distinct and resumable", async () => {
  for (const subtype of ["error_max_budget_usd", "error_max_turns"] as const) {
    const bindings: Binding[] = [];
    const result = await consumeTask({
      query: stream({ ...base, subtype, is_error: true, errors: ["limit"] }),
      cwd: "/repo",
      before: zeroTotals(),
      bind: (b) => bindings.push(b),
      update() {},
    });
    assert.equal(result.status, "error");
    if (result.status === "error")
      assert.equal(result.reason, subtype === "error_max_turns" ? "turns" : "budget");
    assert.equal(result.sessionId, id);
    assert.equal(bindings.at(-1)?.totals.cost, 0.1);
  }
  const result = await consumeTask({
    query: stream(),
    cwd: "/repo",
    before: zeroTotals(),
    bind() {},
    update() {},
  });
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.reason, "protocol");
});

test("resumed cumulative usage is charged once, output is capped, and original SDK ids survive activity", async () => {
  const updates: string[] = [];
  const progress = {
    type: "tool_progress",
    tool_use_id: "original-shell-id",
    tool_name: "Bash",
    parent_tool_use_id: null,
    elapsed_time_seconds: 1,
    uuid: id,
    session_id: id,
  } satisfies SDKMessage;
  const result = await consumeTask({
    query: stream(progress, { ...success, result: "x".repeat(OUTPUT_LIMIT * 2) }),
    cwd: "/repo",
    expectedSessionId: id,
    before: { input: 50, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0.05 },
    bind() {},
    update: (s) => updates.push(s),
  });
  assert.equal(result.text.length, OUTPUT_LIMIT);
  assert.equal(result.usage?.totalTokens, 75);
  assert.equal(result.usage?.cost.total, 0.05);
  assert.ok(updates[0].includes("original-shell-id"));
  await assert.rejects(
    consumeTask({
      query: stream(success),
      cwd: "/repo",
      expectedSessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      before: zeroTotals(),
      bind() {},
      update() {},
    }),
  );
  await assert.rejects(
    consumeTask({
      query: stream(success, success),
      cwd: "/repo",
      before: zeroTotals(),
      bind() {},
      update() {},
    }),
  );
});

test("owned worker closes before releasing control, including a process ignoring stdin EOF", async () => {
  const process = ownedProcess();
  const child = process.spawn({
    command: globalThis.process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: globalThis.process.cwd(),
    env: {},
    signal: new AbortController().signal,
  });
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once("exit", (code, signal) => resolve([code, signal])),
  );
  await process.close();
  const [code, signal] = await exited;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function taskFixture(overrides: Partial<TaskServices> = {}) {
  const gate = new WriterGate();
  const records: Binding[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const services: TaskServices = {
    canonicalCheckout: async () => "/canonical/repo",
    resolveClaude: async () => "/installed/claude",
    preflight: async () => {
      events.push("auth");
    },
    ownedProcess: () => ({
      spawn: () => {
        throw new Error("The fake SDK must not spawn a CLI.");
      },
      close: async () => {
        events.push("worker-closed");
      },
    }),
    query: () => {
      events.push("query");
      return {
        ...stream(success),
        close() {
          events.push("query-closed");
        },
      };
    },
    runtimeMs: 60_000,
    ...overrides,
  };
  const runner = new TaskRunner(gate, services);
  const request: Parameters<TaskRunner["execute"]>[0] = {
    toolCallId: "original-pi-call",
    params: { task: "fixture", cwd: "/alias/repo" },
    ui: { hasUI: false, ui: { confirm: async () => false } },
    bind: (binding) => records.push(binding),
    update() {},
    cleanupError: (message) => errors.push(message),
  };
  return { gate, records, errors, events, runner, request };
}
test("real task runner does not query or allocate a worker after auth rejection", async () => {
  const fixture = taskFixture({
    preflight: async () => requireSubscriptionAuth({ loggedIn: false, authMethod: "none" }),
  });
  const result = await fixture.runner.execute(fixture.request);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.reason, "auth");
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.gate.busy, false);
});
test("real task runner persists canonical binding and closes the query before the worker and lease", async () => {
  const fixture = taskFixture();
  const result = await fixture.runner.execute(fixture.request);
  assert.equal(result.status, "success");
  assert.equal(result.cwd, "/canonical/repo");
  assert.equal(result.sessionId, id);
  assert.deepEqual(fixture.events, ["auth", "query", "query-closed", "worker-closed"]);
  assert.equal(fixture.records[0].cwd, "/canonical/repo");
  assert.equal(fixture.records.at(-1)?.totals.cost, 0.1);
  assert.equal(fixture.gate.busy, false);
});
test("cancel and session stop wait for worker close while blocking nested writers", async () => {
  const started = deferred<void>(),
    closing = deferred<void>(),
    closed = deferred<void>();
  const fixture = taskFixture({
    query: ({ options }) => ({
      async *[Symbol.asyncIterator]() {
        const signal = options.abortController?.signal;
        assert.ok(signal);
        const aborted = new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        started.resolve();
        yield {
          type: "tool_progress",
          tool_use_id: "shell-id",
          tool_name: "Bash",
          parent_tool_use_id: null,
          elapsed_time_seconds: 1,
          uuid: id,
          session_id: id,
        } satisfies SDKMessage;
        await aborted;
        throw new Error("aborted");
      },
      close() {
        closing.resolve();
      },
    }),
    ownedProcess: () => ({
      spawn() {
        throw new Error("no CLI");
      },
      close: () => closed.promise,
    }),
  });
  const running = fixture.runner.execute(fixture.request);
  await started.promise;
  const stopping = fixture.runner.stop();
  await closing.promise;
  assert.throws(() => fixture.gate.beginLocal("codemode/child"));
  let settled = false;
  void stopping.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  closed.resolve();
  const result = await running;
  await stopping;
  assert.equal(result.status, "cancelled");
  assert.equal(fixture.gate.busy, false);
});
test("user abort during auth never starts a query; runtime timeout is a distinct terminal", async () => {
  const entered = deferred<void>();
  const controller = new AbortController();
  const auth = taskFixture({
    preflight: async (_cli, _cwd, _env, signal) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
    },
  });
  const pending = auth.runner.execute({ ...auth.request, signal: controller.signal });
  await entered.promise;
  controller.abort();
  assert.equal((await pending).status, "cancelled");
  assert.deepEqual(auth.events, []);
  const timeout = taskFixture({
    runtimeMs: 10,
    preflight: async (_cli, _cwd, _env, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
    },
  });
  const result = await timeout.runner.execute(timeout.request);
  assert.equal(result.status, "cancelled");
  if (result.status === "cancelled") assert.equal(result.reason, "timeout");
});
test("cleanup failure is visible and retains the lease, even when query.close throws", async () => {
  let workerClosed = false;
  const fixture = taskFixture({
    query: () => ({
      ...stream(success),
      close() {
        throw new Error("query cleanup failed");
      },
    }),
    ownedProcess: () => ({
      spawn() {
        throw new Error("no CLI");
      },
      async close() {
        workerClosed = true;
        throw new Error("worker cleanup failed");
      },
    }),
  });
  const result = await fixture.runner.execute(fixture.request);
  assert.equal(workerClosed, true);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.reason, "cleanup");
  assert.equal(fixture.errors.length, 1);
  assert.ok(result.text.includes("query cleanup failed"));
  assert.ok(result.text.includes("worker cleanup failed"));
  assert.equal(fixture.gate.busy, true);
});

test("SDK forwarded abort closes a real disposable worker without a false cleanup failure", async () => {
  const process = ownedProcess();
  const controller = new AbortController();
  const child = process.spawn({
    command: globalThis.process.execPath,
    args: ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    cwd: globalThis.process.cwd(),
    env: {},
    signal: controller.signal,
  });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  controller.abort();
  await process.close();
  assert.notEqual(child.signalCode, null);
});
