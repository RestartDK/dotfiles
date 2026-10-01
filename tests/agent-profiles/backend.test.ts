import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  BackendRunner,
  initialSessionResult,
  reduceSessionEvent,
  terminalOutcome,
  type BackendTask,
  type Execution,
  type Runtime,
  type SessionProgress,
  type WorkerSessionOptions,
  type WorkerSessionResult,
} from "../../config/pi/agent/extensions/subagents/backend";
import { initialUsage } from "../../config/pi/agent/extensions/subagents/protocol";
import { parsePolicy, resolveRoute } from "../../config/pi/agent/lib/model-policy";

const directories: string[] = [];
const originalXdg = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

type SessionCall = {
  options: WorkerSessionOptions;
  text: string;
  disposed: number;
};

function profilePolicy(profile: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    readFileSync(
      join(import.meta.dir, `../../config/agents/model-profiles/${profile}.json`),
      "utf8",
    ),
  );
  if (typeof value !== "object" || value === null) throw new Error("invalid profile");
  const policy = value as Record<string, unknown>;
  const routes = policy.routes as Record<string, unknown>;
  const roles = policy.roles as Record<string, unknown>;
  routes.fallback = [
    { kind: "pi", model: "openrouter/z-ai/glm-5.3-flash", thinking: "max" },
    { kind: "pi", model: "openai/gpt-6-astra", thinking: "xhigh" },
  ];
  roles["fallback-role"] = { kind: "single", route: "fallback" };
  return policy;
}

function result(over: Partial<WorkerSessionResult> = {}): WorkerSessionResult {
  return {
    outcome: { kind: "success" },
    output: "ok",
    usage: initialUsage(),
    toolUsed: false,
    ...over,
  };
}

function setup(profile = "personal", role?: "fallback-role") {
  const dir = mkdtempSync(join(tmpdir(), "agent-backend-test-"));
  directories.push(dir);
  const configDir = join(dir, "config");
  mkdirSync(join(configDir, "dstack"), { recursive: true });
  const policyJson = profilePolicy(profile);
  writeFileSync(join(configDir, "dstack/models.json"), JSON.stringify(policyJson));
  process.env.XDG_CONFIG_HOME = configDir;
  const policy = parsePolicy(policyJson);
  const task: BackendTask = {
    route: resolveRoute(policy, { role: role ?? "review" }),
    cwd: dir,
    task: "Report once",
    systemPrompt: "preset instruction",
    tools: [],
  };
  const sessions: SessionCall[] = [];
  const scripts: Array<(options: WorkerSessionOptions) => Promise<WorkerSessionResult>> = [];
  const runtime: Runtime = {
    session: async (options) => {
      const call: SessionCall = { options, text: "", disposed: 0 };
      sessions.push(call);
      const script = scripts.shift();
      if (!script) throw new Error("No scripted session result");
      return {
        prompt: async (text: string) => {
          call.text = text;
          return script(options);
        },
        dispose: async () => {
          call.disposed++;
        },
      };
    },
    now: () => 1_800_000_000_000,
  };
  const script = (
    ...results: Array<
      | WorkerSessionResult
      | Error
      | ((options: WorkerSessionOptions) => Promise<WorkerSessionResult>)
    >
  ) => {
    for (const entry of results)
      scripts.push(async (options) => {
        if (entry instanceof Error) throw entry;
        if (typeof entry === "function") return entry(options);
        return entry;
      });
  };
  return { dir, task, sessions, runtime, script, policy };
}

describe("typed backend sessions", () => {
  test("drives one typed session with the route's target, task and tools", async () => {
    const { runtime, task, sessions, script } = setup();
    task.tools = ["read", "grep"];
    script(
      result({
        output: "done",
        actualModel: "openai/gpt-6-astra",
        usage: {
          input: 5,
          output: 8,
          cacheRead: 1,
          cacheWrite: 2,
          cost: 0.25,
          contextTokens: 16,
          turns: 1,
        },
      }),
    );
    const activities: string[] = [];
    const controller = new AbortController();
    const execution = await new BackendRunner(runtime).run(task, controller.signal, (update) => {
      if (update.activity) activities.push(update.activity);
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.options).toMatchObject({
      cwd: task.cwd,
      target: { kind: "pi", provider: "openai", id: "gpt-6-astra", thinking: "xhigh" },
      systemPrompt: "preset instruction",
      tools: ["read", "grep", "codemode"],
    });
    expect(sessions[0]?.options.signal).toBeInstanceOf(AbortSignal);
    expect(sessions[0]?.options.signal?.aborted).toBe(false);
    expect(sessions[0]?.text).toBe("Delegated task:\n\nReport once");
    expect(execution.outcome).toEqual({ kind: "success" });
    expect(execution.actual).toEqual({ backend: "pi", model: "openai/gpt-6-astra" });
    expect(execution.usage).toMatchObject({
      input: 5,
      output: 8,
      cacheRead: 1,
      cacheWrite: 2,
      cost: 0.25,
      contextTokens: 16,
      turns: 1,
    });

    sessions[0]?.options.onProgress?.({
      activity: "agent_start",
      usage: initialUsage(),
      output: "",
      toolUsed: false,
    });
    expect(activities).toContain("agent_start");
    expect(sessions[0]?.disposed).toBe(1);
  });

  test("concurrent workers keep their own route targets", async () => {
    const { runtime, task, sessions, script, policy } = setup();
    const astra = { ...task, route: resolveRoute(policy, { role: "review" }) };
    const deepseek = { ...task, route: resolveRoute(policy, { role: "feature" }) };
    script(result({ output: "a" }), result({ output: "b" }));
    await Promise.all([
      new BackendRunner(runtime).run(astra),
      new BackendRunner(runtime).run(deepseek),
    ]);
    expect(sessions.map((session) => session.options.target)).toEqual([
      { kind: "pi", provider: "openai", id: "gpt-6-astra", thinking: "xhigh" },
      { kind: "pi", provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", thinking: "max" },
    ]);
  });

  test("empty tools still activate codemode", async () => {
    const { runtime, task, sessions, script } = setup();
    script(result());
    expect((await new BackendRunner(runtime).run(task)).outcome).toEqual({ kind: "success" });
    expect(sessions[0]?.options.tools).toEqual(["codemode"]);
  });

  test("live progress forwards running usage, output and tool use before the attempt ends", async () => {
    const { runtime, task, script } = setup();
    script(
      (options) =>
        new Promise<WorkerSessionResult>((resolve) => {
          options.onProgress?.({
            activity: "message_start",
            usage: {
              input: 7,
              output: 3,
              cacheRead: 1,
              cacheWrite: 0,
              cost: 0.25,
              contextTokens: 10,
              turns: 1,
            },
            output: "streaming",
            toolUsed: true,
            actualModel: "openai/gpt-6-astra",
          });
          resolve(result());
        }),
    );
    const updates: Execution[] = [];
    await new BackendRunner(runtime).run(task, undefined, (execution) => {
      updates.push(structuredClone(execution));
    });
    expect(
      updates.some(
        (execution) =>
          execution.output === "streaming" &&
          execution.toolUsed &&
          execution.usage.input === 7 &&
          execution.actual?.model === "openai/gpt-6-astra",
      ),
    ).toBe(true);
  });

  test("provider failure advances once and sums usage across attempts", async () => {
    const { runtime, task, sessions, script } = setup("personal", "fallback-role");
    script(
      result({
        outcome: { kind: "provider-failure", reason: "quota" },
        output: "partial",
        actualModel: "openrouter/z-ai/glm-5.3-flash",
        usage: {
          input: 1,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          cost: 0.5,
          contextTokens: 11,
          turns: 1,
        },
      }),
      result({
        output: "recovered",
        actualModel: "openai/gpt-6-astra",
        usage: {
          input: 5,
          output: 6,
          cacheRead: 7,
          cacheWrite: 8,
          cost: 1.5,
          contextTokens: 22,
          turns: 2,
        },
      }),
    );
    const execution = await new BackendRunner(runtime).run(task);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((call) => call.options.target.id)).toEqual([
      "z-ai/glm-5.3-flash",
      "gpt-6-astra",
    ]);
    expect(execution.attempts.map((attempt) => attempt.kind)).toEqual([
      "provider-failure",
      "success",
    ]);
    expect(execution.attempts[0]).toMatchObject({
      reason: "quota",
      actualModel: "openrouter/z-ai/glm-5.3-flash",
    });
    expect(execution.outcome).toEqual({ kind: "success" });
    expect(execution.output).toBe("recovered");
    expect(execution.actual).toEqual({ backend: "pi", model: "openai/gpt-6-astra" });
    expect(execution.usage).toMatchObject({
      input: 6,
      output: 8,
      cacheRead: 10,
      cacheWrite: 12,
      cost: 2,
      contextTokens: 22,
      turns: 3,
    });
  });

  test("a thrown session prompt is a failure, not a fallback", async () => {
    const { runtime, task, sessions, script } = setup();
    script(new Error("boom"));
    const execution = await new BackendRunner(runtime).run(task);
    expect(execution.outcome).toEqual({ kind: "failed", reason: "boom" });
    expect(execution.attempts).toHaveLength(1);
    expect(sessions[0]?.disposed).toBe(1);
  });

  test("a thrown session error routes through provider failure classification", async () => {
    const { runtime, task, sessions, script } = setup("personal", "fallback-role");
    script(
      new Error('OpenAI API error (429): {"type":"insufficient_quota","message":"quota"}'),
      result(),
    );
    const execution = await new BackendRunner(runtime).run(task);
    expect(execution.attempts[0]).toMatchObject({ kind: "provider-failure", reason: "quota" });
    expect(execution.outcome).toEqual({ kind: "success" });
    expect(sessions).toHaveLength(2);
  });

  test("missing credentials advance only through the recognized auth failure", async () => {
    const { runtime, task, script } = setup("personal", "fallback-role");
    script(result({ outcome: { kind: "provider-failure", reason: "auth" } }), result());
    const execution = await new BackendRunner(runtime).run(task);
    expect(execution.attempts.map((attempt) => attempt.kind)).toEqual([
      "provider-failure",
      "success",
    ]);
    expect(execution.attempts[0]).toMatchObject({ reason: "auth" });
  });

  test("tool use before a provider failure blocks replay with reconciliation", async () => {
    const { runtime, task, script } = setup("personal", "fallback-role");
    script(
      result({
        outcome: { kind: "provider-failure", reason: "quota" },
        toolUsed: true,
        output: "partial",
      }),
    );
    const execution = await new BackendRunner(runtime).run(task);
    expect(execution.toolUsed).toBe(true);
    expect(execution.outcome).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("parent must reconcile"),
    });
    expect(execution.attempts).toHaveLength(1);
    expect(execution.output).toBe("partial");
  });

  test("tool use on a later successful attempt stays successful", async () => {
    const { runtime, task, script } = setup("personal", "fallback-role");
    script(result({ outcome: { kind: "provider-failure", reason: "quota" } }));
    script(result({ toolUsed: true, output: "done" }));
    const execution = await new BackendRunner(runtime).run(task);
    expect(execution.outcome).toEqual({ kind: "success" });
    expect(execution.toolUsed).toBe(true);
    expect(execution.output).toBe("done");
    expect(execution.attempts.map((attempt) => attempt.kind)).toEqual([
      "provider-failure",
      "success",
    ]);
  });

  test("cooldowns honor expiry and never bypass the final endpoint", async () => {
    const { runtime, task, script } = setup("personal", "fallback-role");
    script(
      result({ outcome: { kind: "provider-failure", reason: "quota" } }),
      result({ outcome: { kind: "provider-failure", reason: "quota" } }),
    );
    const runner = new BackendRunner(runtime);
    await runner.run(task);
    const second = await runner.run(task);
    expect(second.attempts.map((attempt) => attempt.kind)).toEqual(["cooldown", "cooldown"]);
    expect(second.outcome.kind).toBe("failed");
    script(
      result({ outcome: { kind: "provider-failure", reason: "quota" } }),
      result({ outcome: { kind: "provider-failure", reason: "quota" } }),
    );
    const advanced: Runtime = { ...runtime, now: () => 1_800_000_061_000 };
    const third = await new BackendRunner(advanced).run(task);
    expect(third.attempts.map((attempt) => attempt.kind)).toEqual([
      "provider-failure",
      "provider-failure",
    ]);
  });

  test("pre-cancelled dispatch never opens a session", async () => {
    const { runtime, task, sessions } = setup();
    const execution = await new BackendRunner(runtime).run(task, AbortSignal.abort());
    expect(execution.outcome).toEqual({ kind: "cancelled" });
    expect(execution.attempts).toEqual([]);
    expect(sessions).toHaveLength(0);
  });

  test("cancellation aborts the live session and never advances", async () => {
    const { runtime, task, sessions, script } = setup("personal", "fallback-role");
    script(
      (options) =>
        new Promise((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => resolve(result({ outcome: { kind: "cancelled" } })),
            { once: true },
          );
          options.onProgress?.({
            activity: "agent_start",
            usage: initialUsage(),
            output: "",
            toolUsed: false,
          });
        }),
    );
    const controller = new AbortController();
    const execution = await new BackendRunner(runtime).run(task, controller.signal, (update) => {
      if (update.activity === "agent_start") controller.abort();
    });
    expect(execution.outcome).toEqual({ kind: "cancelled" });
    expect(execution.attempts).toHaveLength(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.disposed).toBe(1);
  });

  test("shutdown cancels active work and prevents subsequent sessions", async () => {
    const { runtime, task, sessions, script } = setup("personal", "fallback-role");
    script(
      (options) =>
        new Promise((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => resolve(result({ outcome: { kind: "cancelled" } })),
            { once: true },
          );
          options.onProgress?.({
            activity: "agent_start",
            usage: initialUsage(),
            output: "",
            toolUsed: false,
          });
        }),
    );
    const runner = new BackendRunner(runtime);
    const execution = await runner.run(task, undefined, (update) => {
      if (update.activity === "agent_start") runner.stop();
    });
    expect(execution.outcome).toEqual({ kind: "cancelled" });
    expect((await runner.run(task)).outcome).toEqual({ kind: "cancelled" });
    expect(sessions).toHaveLength(1);
  });
});

const usage = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
};

function assistant(over: Record<string, unknown> = {}): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
      api: "openai-completions",
      content: [{ type: "text", text: "answer" }],
      stopReason: "stop",
      timestamp: 0,
      usage,
      ...over,
    },
  } as AgentSessionEvent;
}

function toolActivity(type: string): AgentSessionEvent {
  return { type } as AgentSessionEvent;
}

describe("session event mapping", () => {
  test.each([
    {
      name: "tool_execution_start latches tool use",
      events: [toolActivity("tool_execution_start")],
      state: { toolUsed: true },
    },
    {
      name: "tool_execution_update latches tool use",
      events: [toolActivity("tool_execution_update")],
      state: { toolUsed: true },
    },
    {
      name: "tool_execution_end latches tool use",
      events: [toolActivity("tool_execution_end")],
      state: { toolUsed: true },
    },
    {
      name: "turn_end with tool results latches tool use",
      events: [{ type: "turn_end", toolResults: [{}] } as AgentSessionEvent],
      state: { toolUsed: true },
    },
    {
      name: "turn_end without tool results does not latch",
      events: [{ type: "turn_end", toolResults: [] } as AgentSessionEvent],
      state: { toolUsed: false },
    },
    {
      name: "toolResult message latches tool use",
      events: [
        {
          type: "message_end",
          message: { role: "toolResult", toolCallId: "t", toolName: "read", content: [] },
        } as AgentSessionEvent,
      ],
      state: { toolUsed: true },
    },
    {
      name: "assistant tool call latches tool use",
      events: [
        assistant({
          content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }],
          stopReason: "toolUse",
        }),
      ],
      state: { toolUsed: true },
    },
    {
      name: "assistant stop is a success with summed usage and output",
      events: [assistant()],
      state: {
        output: "answer",
        actualModel: "openrouter/deepseek/deepseek-v4.1-flash",
        outcome: { kind: "success" },
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 },
      },
    },
    {
      name: "assistant length is a success",
      events: [assistant({ stopReason: "length" })],
      state: { outcome: { kind: "success" } },
    },
    {
      name: "assistant aborted is a failure",
      events: [assistant({ stopReason: "aborted" })],
      state: { outcome: { kind: "failed", reason: "Pi aborted" } },
    },
    {
      name: "assistant error classifies a native quota envelope",
      events: [
        assistant({
          stopReason: "error",
          errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"x"}}',
        }),
      ],
      state: { outcome: { kind: "provider-failure", reason: "quota" } },
    },
    {
      name: "quota after tool use keeps the latch and the provider failure",
      events: [
        toolActivity("tool_execution_start"),
        assistant({
          stopReason: "error",
          errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"x"}}',
        }),
      ],
      state: { toolUsed: true, outcome: { kind: "provider-failure", reason: "quota" } },
    },
    {
      name: "a substituted response model fails the attempt",
      events: [assistant({ responseModel: "deepseek/deepseek-v4.1-flash-preview" })],
      state: {
        outcome: {
          kind: "failed",
          reason: expect.stringContaining("not the requested"),
        },
      },
    },
    {
      name: "usage and turns sum across assistant messages",
      events: [assistant(), assistant({ content: [{ type: "text", text: "second" }] })],
      state: {
        output: "second",
        usage: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, cost: 1, turns: 2 },
      },
    },
  ] satisfies Array<{ name: string; events: AgentSessionEvent[]; state: unknown }>)(
    "$name",
    ({ events, state }) => {
      expect(events.reduce(reduceSessionEvent, initialSessionResult())).toMatchObject(state);
    },
  );

  test("a session with no terminal message reports the missing terminal result", () => {
    const state = [toolActivity("tool_execution_start")].reduce(
      reduceSessionEvent,
      initialSessionResult(),
    );
    expect(state.outcome).toBeUndefined();
    expect(terminalOutcome(state)).toMatchObject({
      kind: "failed",
      reason: "Session exited without a terminal result",
    });
  });

  test("assistant output is bounded to 50 KiB", () => {
    const text = "x".repeat(60 * 1024);
    const state = reduceSessionEvent(
      initialSessionResult(),
      assistant({ content: [{ type: "text", text }] }),
    );
    expect(Buffer.byteLength(state.output, "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(state.output).toContain("[output truncated]");
  });
});
