import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackendRunner,
  claudeTools,
  instructionFiles,
  subscriptionEnv,
  type BackendTask,
  type Runtime,
} from "../../config/pi/agent/extensions/subagents/backend";
import {
  isRecord,
  parsePolicy,
  resolveRoute,
} from "../../config/pi/agent/extensions/subagents/policy";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup(scenario: Record<string, unknown>, profile = "personal") {
  const dir = mkdtempSync(join(tmpdir(), "agent-backend-test-"));
  directories.push(dir);
  const path = join(dir, "scenario.json");
  writeFileSync(path, JSON.stringify(scenario));
  const runtime: Runtime = {
    pi: (args) => ({
      command: process.execPath,
      args: [join(import.meta.dir, "fixture.ts"), "pi", path, ...args],
    }),
    claude: (args) => ({
      command: process.execPath,
      args: [join(import.meta.dir, "fixture.ts"), "claude", path, ...args],
    }),
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      ANTHROPIC_API_KEY: "fixture-secret",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-secret",
    },
    now: () => 1_800_000_000_000,
  };
  const policy = parsePolicy(
    JSON.parse(
      readFileSync(
        join(import.meta.dir, `../../config/agents/model-profiles/${profile}.json`),
        "utf8",
      ),
    ),
  );
  const task: BackendTask = {
    route: resolveRoute(policy, { role: "review" }),
    cwd: dir,
    task: "Report once",
    systemPrompt: "preset instruction",
    contextFiles: [],
    tools: [],
  };
  const calls = () =>
    readFileSync(`${path}.calls`, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value) || !Array.isArray(value.args) || !isRecord(value.env))
          throw new Error("invalid fixture call");
        return { args: value.args, env: value.env, backend: value.backend, prompt: value.prompt };
      });
  return { runtime, task, calls, runner: new BackendRunner(runtime), path, policy };
}

describe("real backend subprocesses", () => {
  test("loads global and ancestor instructions with override and Claude fallback precedence", () => {
    const { task } = setup({});
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
  test("split stream, allowed limits, scoped tools, system context and subscription auth", async () => {
    const { runner, task, calls } = setup({ claude: "allowed", split: true });
    const context = join(task.cwd, "AGENTS.md");
    writeFileSync(context, "project instruction");
    task.contextFiles = [context];
    task.tools = ["read", "grep", "find", "ls"];
    const result = await runner.run(task);
    expect(result.outcome.kind).toBe("success");
    expect(result.actual).toEqual({ backend: "claude-cli", model: "claude-fable-5-1" });
    expect(result.attempts).toHaveLength(1);
    expect(result.usage.output).toBe(3);
    expect(result.usage.turns).toBe(1);
    const auth = calls().find((call) => call.args.includes("auth"));
    expect(auth?.args).toEqual([
      "--safe-mode",
      "--setting-sources",
      "",
      "auth",
      "status",
      "--json",
    ]);
    const request = calls().find((call) => call.args.includes("-p"));
    expect(request?.args).toContain("Read,Grep,Glob");
    expect(request?.args).toContain("--safe-mode");
    expect(request?.args).toContain("--strict-mcp-config");
    expect(request?.args).not.toContain("--bare");
    expect(request?.args).not.toContain("--dangerously-skip-permissions");
    expect(request?.args).toContain("--append-system-prompt-file");
    expect(request?.prompt).toContain("project instruction");
    expect(request?.prompt).toContain("preset instruction");
    for (const call of calls()) {
      expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(call.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(call.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    }
  });

  test.each(["allowed", "allowed_warning"])("%s is not a failure or a cooldown", async (mode) => {
    const { runner, task } = setup({ claude: mode });
    expect((await runner.run(task)).outcome.kind).toBe("success");
    expect((await runner.run(task)).attempts[0]?.kind).toBe("success");
  });

  test("quota before tools falls back once and reports actual Astra", async () => {
    const { runner, task } = setup({ claude: "quota", pi: "success" });
    const result = await runner.run(task);
    expect(result.outcome.kind).toBe("success");
    expect(result.attempts.map((attempt) => attempt.kind)).toEqual(["provider-failure", "success"]);
    expect(result.actual).toEqual({ backend: "pi", model: "openai-codex/gpt-6-astra" });
    expect(result.output).toBe("pi-ok");
  });

  test("work Fable tries API Fable then API Astra without changing providers", async () => {
    const { runner, task, calls } = setup({ claude: "quota", pi: "quota" }, "work");
    const result = await runner.run(task);
    expect(result.attempts).toHaveLength(3);
    expect(
      calls()
        .filter((call) => call.backend === "pi" && call.args.includes("-p"))
        .map((call) => [
          call.args[call.args.indexOf("--provider") + 1],
          call.args[call.args.indexOf("--model") + 1],
        ]),
    ).toEqual([
      ["anthropic", "claude-fable-5-1"],
      ["openai", "gpt-6-astra"],
    ]);
    const second = await runner.run(task);
    expect(second.attempts.map((attempt) => attempt.kind)).toEqual([
      "cooldown",
      "cooldown",
      "cooldown",
    ]);
    expect(second.outcome.kind).toBe("failed");
  });

  test.each([
    "tool-failure",
    "unknown",
    "unknown-event",
    "aborted-streaming",
    "aborted-tools",
    "task-failure",
    "budget",
    "malformed",
    "truncated",
    "overflow",
    "wrong-model",
    "extra-tool",
    "api-source",
    "hook",
  ])("%s never falls back", async (mode) => {
    const { runner, task, calls } = setup({ claude: mode });
    if (mode === "tool-failure") task.tools = ["read"];
    const result = await runner.run(task);
    expect(result.outcome.kind).toBe("failed");
    expect(calls().some((call) => call.backend === "pi")).toBe(false);
    if (mode === "tool-failure") {
      expect(result.output).toBe("partial");
      expect(result.toolUsed).toBe(true);
      expect(result.outcome).toMatchObject({
        reason: expect.stringContaining("parent must reconcile"),
      });
    }
  });

  test.each(["api", "logged-out"])(
    "auth %s advances without a Claude paid request",
    async (auth) => {
      const { runner, task, calls } = setup({ auth });
      const result = await runner.run(task);
      expect(result.actual?.backend).toBe("pi");
      expect(calls().some((call) => call.backend === "claude" && call.args.includes("-p"))).toBe(
        false,
      );
    },
  );

  test("missing API credentials skip the request and advance to the next exact provider", async () => {
    const { runner, task, calls } = setup({ claude: "quota", piAuth: "missing-anthropic" }, "work");
    const result = await runner.run(task);
    expect(result.outcome.kind).toBe("success");
    expect(result.actual?.model).toBe("openai/gpt-6-astra");
    const requests = calls().filter((call) => call.backend === "pi" && call.args.includes("-p"));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.args).toContain("openai");
    expect(requests[0]?.args).toContain("gpt-6-astra");
  });

  test.each(["malformed", "wrong-provider"])(
    "Pi auth %s stops without a model request",
    async (piAuth) => {
      const { runner, task, calls } = setup({ claude: "quota", piAuth }, "work");
      expect((await runner.run(task)).outcome.kind).toBe("failed");
      expect(calls().some((call) => call.backend === "pi" && call.args.includes("-p"))).toBe(false);
    },
  );

  test("missing cwd is a configuration failure, not a missing executable", async () => {
    const { runner, task, calls } = setup({ claude: "success" });
    task.cwd = join(task.cwd, "missing-directory");
    const result = await runner.run(task);
    expect(result.outcome.kind).toBe("failed");
    expect(result.attempts).toHaveLength(1);
    expect(() => calls()).toThrow();
  });

  test("malformed auth stops and missing executable advances", async () => {
    const { runtime, task } = setup({ auth: "malformed" });
    expect((await new BackendRunner(runtime).run(task)).outcome.kind).toBe("failed");
    runtime.claude = () => ({ command: "/missing-claude-fixture", args: [] });
    expect(
      (await new BackendRunner(runtime).run(task)).attempts.map((attempt) => attempt.kind),
    ).toEqual(["provider-failure", "success"]);
  });

  test("cooldown honors seconds, expires, and does not bypass the final endpoint", async () => {
    const { runner, runtime, task } = setup({
      claude: "quota",
      pi: "quota",
      resetAt: 1_800_000_120,
    });
    await runner.run(task);
    expect((await runner.run(task)).attempts.map((attempt) => attempt.kind)).toEqual([
      "cooldown",
      "cooldown",
    ]);
    runtime.now = () => 1_800_000_061_000;
    expect((await runner.run(task)).attempts.map((attempt) => attempt.kind)).toEqual([
      "cooldown",
      "provider-failure",
    ]);
    runtime.now = () => 1_800_000_122_000;
    expect((await runner.run(task)).attempts.map((attempt) => attempt.kind)).toEqual([
      "provider-failure",
      "provider-failure",
    ]);
  });

  test("pre-cancelled dispatch does not spawn; cancellation on terminal failure never advances", async () => {
    const { runner, task, calls } = setup({ claude: "quota" });
    const pre = AbortSignal.abort();
    expect((await runner.run(task, pre)).attempts).toEqual([]);
    const controller = new AbortController();
    const result = await runner.run(task, controller.signal, (update) => {
      if (update.output === "partial") controller.abort();
    });
    expect(result.outcome.kind).toBe("cancelled");
    expect(calls().some((call) => call.backend === "pi")).toBe(false);
  });

  test("shutdown cancels active work and prevents subsequent spawns", async () => {
    const { runner, task, calls } = setup({ claude: "quota" });
    const result = await runner.run(task, undefined, (update) => {
      if (update.output === "partial") runner.stop();
    });
    expect(result.outcome.kind).toBe("cancelled");
    const count = calls().length;
    expect((await runner.run(task)).outcome.kind).toBe("cancelled");
    expect(calls()).toHaveLength(count);
  });

  test("cancellation kills a TERM-resistant child and its descendants", async () => {
    const { runner, task } = setup({ claude: "hang" });
    const controller = new AbortController();
    let descendant = 0;
    const result = await runner.run(task, controller.signal, (update) => {
      const match = /descendant=(\d+)/.exec(update.output);
      if (match) {
        descendant = Number(match[1]);
        controller.abort();
      }
    });
    expect(result.outcome.kind).toBe("cancelled");
    expect(descendant).toBeGreaterThan(0);
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt++) {
      try {
        process.kill(descendant, 0);
        if (
          process.platform === "linux" &&
          /\) Z /.test(readFileSync(`/proc/${descendant}/stat`, "utf8"))
        )
          alive = false;
      } catch {
        alive = false;
      }
      if (alive) await Bun.sleep(10);
    }
    expect(alive).toBe(false);
  });

  test("unsupported tools fail before auth and empty tools remain empty", async () => {
    const { runner, task, calls } = setup({ claude: "success" });
    task.tools = ["mcp"];
    expect((await runner.run(task)).outcome.kind).toBe("failed");
    expect(() => calls()).toThrow();
    task.tools = [];
    expect((await runner.run(task)).outcome.kind).toBe("success");
    expect(calls().find((call) => call.args.includes("-p"))?.args).toContain("");
    expect(claudeTools(["ls"])).toEqual(["Glob"]);
    expect(
      subscriptionEnv({
        HOME: "/home/test",
        ANTHROPIC_BASE_URL: "evil",
        CLAUDE_CONFIG_DIR: "evil",
      }),
    ).toEqual({ HOME: "/home/test" });
  });

  test("bounded output", async () => {
    const { runner, task } = setup({ claude: "large-output" });
    const result = await runner.run(task);
    expect(result.outcome.kind).toBe("success");
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(50 * 1024);
  });

  test.each([
    "tool-failure",
    "unknown",
    "unknown-event",
    "wrong-provider",
    "stderr-quota",
    "stdout-quota",
  ])("Pi %s never authorizes another route", async (mode) => {
    const { runner, task } = setup({ claude: "quota", pi: mode }, "work");
    const result = await runner.run(task);
    expect(result.attempts).toHaveLength(2);
    expect(result.outcome.kind).toBe(mode === "stdout-quota" ? "success" : "failed");
  });
});
