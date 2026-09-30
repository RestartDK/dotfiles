import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackendRunner,
  instructionFiles,
  type BackendTask,
  type Runtime,
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
    { kind: "pi", model: "openai-codex/gpt-6-astra", thinking: "xhigh" },
  ];
  roles["fallback-role"] = { kind: "single", route: "fallback" };
  return policy;
}

function result(over: Partial<WorkerSessionResult> = {}): WorkerSessionResult {
  return {
    outcome: { kind: "success" },
    output: "ok",
    stderr: "",
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
    contextFiles: [],
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
  test("loads global and ancestor instructions with override precedence", () => {
    const { task } = setup();
    const dir = task.cwd;
    const global = join(dir, "agent");
    const repo = join(dir, "repo");
    const child = join(repo, "child");
    mkdirSync(global);
    mkdirSync(child, { recursive: true });
    for (const path of [
      join(global, "CLAUDE.md"),
      join(repo, "AGENTS.md"),
      join(repo, "CLAUDE.md"),
      join(child, "AGENTS.override.md"),
      join(child, "AGENTS.md"),
    ])
      writeFileSync(path, "Repository instructions");
    expect(instructionFiles(child, global).filter((path) => path.startsWith(dir))).toEqual([
      join(global, "CLAUDE.md"),
      join(repo, "AGENTS.md"),
      join(child, "AGENTS.override.md"),
    ]);
  });

  test("drives one typed session with the route's provider, model, effort and task", async () => {
    const { runtime, task, sessions, script } = setup();
    task.tools = ["read", "grep"];
    script(
      result({
        output: "done",
        actualModel: "openai-codex/gpt-6-astra",
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
      provider: "openai-codex",
      model: "gpt-6-astra",
      thinking: "xhigh",
      systemPrompt: "preset instruction",
      tools: ["read", "grep", "codemode"],
    });
    expect(sessions[0]?.options.signal).toBeDefined();
    expect(sessions[0]?.text).toBe("Delegated task:\n\nReport once");
    sessions[0]?.options.onActivity?.("agent_start");
    expect(activities).toContain("agent_start");
    expect(sessions[0]?.disposed).toBe(1);
    expect(execution.outcome).toEqual({ kind: "success" });
    expect(execution.actual).toEqual({ backend: "pi", model: "openai-codex/gpt-6-astra" });
    expect(execution.usage).toMatchObject({
      input: 5,
      output: 8,
      cacheRead: 1,
      cacheWrite: 2,
      cost: 0.25,
      contextTokens: 16,
      turns: 1,
    });
  });

  test("empty tools still activate codemode", async () => {
    const { runtime, task, sessions, script } = setup();
    script(result());
    expect((await new BackendRunner(runtime).run(task)).outcome).toEqual({ kind: "success" });
    expect(sessions[0]?.options.tools).toEqual(["codemode"]);
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
        actualModel: "openai-codex/gpt-6-astra",
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
    expect(sessions.map((call) => call.options.model)).toEqual([
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
    expect(execution.actual).toEqual({ backend: "pi", model: "openai-codex/gpt-6-astra" });
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

  test("a failed policy invocation stops before any session", async () => {
    const { runtime, task, sessions, script } = setup();
    script(result());
    writeFileSync(
      join(process.env.XDG_CONFIG_HOME ?? "", "dstack/models.json"),
      JSON.stringify(profilePolicy("work")),
    );
    const execution = await new BackendRunner(runtime).run(task);
    expect(execution.outcome).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("changed worker profile"),
    });
    expect(sessions).toHaveLength(0);
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
          options.onActivity?.("agent_start");
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
          options.onActivity?.("agent_start");
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
