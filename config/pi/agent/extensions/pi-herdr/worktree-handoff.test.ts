import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import {
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type AgentActivityOutcome,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { AuthStorage } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { parseArgs } from "./node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js";
import { loadExtensionFromFactory } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

import type { HerdrClient } from "./client.ts";
import { observePaneForeground } from "./pane-foreground.ts";
import type { PaneInfo, WorkspaceInfo } from "./generated/success-response.ts";
import { claimCheckout, releaseCheckout, type WorktreeWorkspace } from "./worktree.ts";
import {
  buildPiHandoffCommand,
  handoffPane,
  handoffResourceArgs,
  registerWorktreeHandoff,
  worktreeBranchFromArg,
} from "./worktree-handoff.ts";
import {
  HANDOFF_ENTRY,
  HandoffReadiness,
  handoffBlock,
  worktreeState,
  type EnterRequest,
  type WorktreeState,
} from "./worktree-state.ts";

const exec = promisify(execFile);
const fixtureForeground: typeof observePaneForeground = (info) =>
  observePaneForeground(info, { platform: "darwin" });
const model: Model<"openai-responses"> = {
  api: "openai-responses",
  provider: "fixture",
  id: "fixture-model",
  name: "Fixture",
  baseUrl: "https://invalid.example",
  reasoning: true,
  input: ["text"],
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const registry = new ModelRegistry(
  await ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath: null,
    refreshOnCreate: false,
  }),
);
const workspace: WorkspaceInfo = {
  workspace_id: "target",
  active_tab_id: "target:tab",
  agent_status: "unknown",
  focused: false,
  label: "task",
  number: 1,
  pane_count: 1,
  tab_count: 1,
};
const pane: PaneInfo = {
  workspace_id: "target",
  tab_id: "target:tab",
  pane_id: "target:pane",
  terminal_id: "terminal",
  agent_status: "unknown",
  focused: false,
  revision: 0,
};
const tab = { ...workspace, tab_id: "target:tab" };
const sourcePane = {
  ...pane,
  workspace_id: "source",
  tab_id: "source:tab",
  pane_id: "source:pane",
  agent: "pi",
};

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "handoff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await exec("git", ["init", "-q", dir]);
  await exec("git", [
    "-C",
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
    "--allow-empty",
  ]);
  const path = join(dir, "task");
  await exec("git", ["-C", dir, "worktree", "add", "-qb", "daniel/task", path]);
  const session = SessionManager.create(dir, join(dir, "sessions"));
  session.appendMessage({
    role: "user",
    content: "Implement this task in a separate worktree.",
    timestamp: 1,
  });
  const sessionFile = session.getSessionFile();
  assert.ok(sessionFile);
  return { dir, path, session, sessionFile };
}

function client(
  path: string,
  options: {
    agents?: PaneInfo[];
    busy?: "agent" | "process";
    initializing?: number;
    tabFailure?: boolean;
    send?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  let processReads = 0;
  const herdr: Pick<HerdrClient, "call"> = {
    async call(method, params) {
      calls.push(method);
      if (method === "workspace.list")
        return {
          type: "workspace_list",
          workspaces: [workspace, { ...workspace, workspace_id: "grouped" }],
        };
      if (method === "pane.get")
        return {
          type: "pane_info",
          pane:
            "pane_id" in params && params.pane_id === "source:pane"
              ? sourcePane
              : {
                  ...pane,
                  pane_id: "target:fresh",
                  agent: options.busy === "agent" ? "pi" : undefined,
                },
        };
      if (method === "pane.process_info") {
        processReads++;
        return {
          type: "pane_process_info",
          process_info: {
            pane_id: "target:fresh",
            shell_pid: processReads <= (options.initializing ?? 0) ? null : 1,
            foreground_process_group_id: options.busy === "process" ? 2 : 1,
          },
        };
      }
      if (method === "pane.list")
        return {
          type: "pane_list",
          panes: options.agents
            ? options.agents.filter(
                (pane) => "workspace_id" in params && pane.workspace_id === params.workspace_id,
              )
            : [{ ...pane, cwd: path }],
        };
      if (method === "tab.get") return { type: "tab_info", tab };
      if (method === "tab.create") {
        if (options.tabFailure) throw new Error("tab unavailable");
        assert.deepEqual(params, {
          workspace_id: "target",
          cwd: path,
          label: "Pi",
          focus: false,
        });
        return {
          type: "tab_created",
          tab: { ...tab, tab_id: "target:fresh-tab" },
          root_pane: { ...pane, tab_id: "target:fresh-tab", pane_id: "target:fresh" },
        };
      }
      if (method === "pane.send_input") {
        await options.send?.();
        return { type: "ok" };
      }
      if (method === "tab.focus") return { type: "tab_info", tab };
      throw new Error(`Unexpected Herdr call ${method}`);
    },
  };
  return { herdr, calls };
}

async function runtime(
  session: SessionManager,
  cwd: string,
  herdr: Pick<HerdrClient, "call">,
  paneId = "source:pane",
) {
  const notifications: string[] = [];
  const prompts: unknown[] = [];
  const errors: string[] = [];
  const controls = {
    shutdown: 0,
    aborted: 0,
    queued: false,
    idle: true,
    operation: new AbortController(),
  };
  const host = createExtensionRuntime();
  host.appendEntry = (type, data) => {
    session.appendCustomEntry(type, data);
  };
  host.getThinkingLevel = () => "high";
  host.getSessionName = () => "Original task";
  host.sendUserMessage = (content) => {
    prompts.push(content);
  };
  const extension = await loadExtensionFromFactory(
    (pi) =>
      registerWorktreeHandoff(pi, {
        herdr,
        currentPaneTarget: paneId,
        observeForeground: fixtureForeground,
      }),
    cwd,
    createEventBus(),
    host,
  );
  const runner = new ExtensionRunner([extension], host, cwd, session, registry);
  runner.bindCore(host, {
    getModel: () => model,
    getScopedModels: () => [],
    isIdle: () => controls.idle,
    isProjectTrusted: () => true,
    getSignal: () => controls.operation.signal,
    abort: () => {
      controls.aborted++;
      controls.operation.abort();
    },
    hasPendingMessages: () => controls.queued,
    shutdown: () => {
      controls.shutdown++;
    },
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "",
  });
  runner.setUIContext(
    {
      ...runner.getUIContext(),
      notify: (message) => {
        notifications.push(message);
      },
    },
    "tui",
  );
  runner.onError((error) => {
    errors.push(error.error);
  });
  const tool = runner.getToolDefinition("worktree_enter");
  if (!tool) throw new Error("worktree_enter was not registered");
  const enterTool = tool;
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "toolCall", name: "worktree_enter", id: "enter", arguments: { branch: "task" } },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "toolUse",
    timestamp: 2,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  async function enter(parameters: EnterRequest = { branch: "task" }) {
    const call = assistant.content.find(
      (part) => part.type === "toolCall" && part.name === "worktree_enter",
    );
    if (call?.type !== "toolCall") throw new Error("worktree_enter call missing");
    call.arguments = parameters;
    const messageEntryId = session.appendMessage(assistant);
    const guard = await runner.emitToolCall({
      type: "tool_call",
      toolCallId: "enter",
      toolName: "worktree_enter",
      input: parameters,
    });
    if (guard?.block) throw new Error(guard.reason);
    const result = await enterTool.execute(
      "enter",
      parameters,
      undefined,
      undefined,
      runner.createToolContext("enter", undefined),
    );
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "enter",
      toolName: "worktree_enter",
      content: result.content,
      isError: false,
      timestamp: 3,
    };
    return {
      result,
      async finish(
        options: { persist?: boolean; outcome?: AgentActivityOutcome; isError?: boolean } = {},
      ) {
        message.isError = options.isError ?? false;
        const toolResultEntryIds =
          options.persist === false ? [] : [session.appendMessage(message)];
        await runner.emitBoundary(
          {
            type: "turn_end",
            turnIndex: 0,
            message: assistant,
            toolResults: [message],
            messageEntryId,
            toolResultEntryIds,
            outcome: options.outcome ?? "completed",
          },
          () => ({
            contextEntries: [],
            contextMessages: [],
            llmMessages: [],
            pendingMessages: [],
            canContinue: true,
          }),
        );
      },
    };
  }
  async function command(name: string, args: string) {
    const command = runner.getCommand(name);
    assert.ok(command);
    await command.handler(args, runner.createCommandContext());
  }
  return { runner, tool, controls, notifications, prompts, errors, assistant, enter, command };
}

test("handoff forks only the saved tool result and shuts down only after successor continuation starts", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 24; i++)
    f.session.appendMessage({
      role: "user",
      content: `Task discussion ${i}`,
      timestamp: i + 4,
    });
  let sent: () => void = () => {};
  const launched = new Promise<void>((resolve) => {
    sent = resolve;
  });
  let successor: Awaited<ReturnType<typeof runtime>> | undefined;
  const c = client(f.path, {
    send: async () => {
      const state = worktreeState(f.session.getBranch());
      assert.equal(state?.kind, "launching");
      assert.ok(state);
      const sourceFile = f.session.getSessionFile();
      assert.ok(sourceFile);
      const fork = SessionManager.forkFrom(sourceFile, f.path, join(f.dir, "successors"), {
        id: state.id,
      });
      assert.equal(
        fork
          .getBranch()
          .filter((entry) => entry.type === "message" && entry.message.role === "user").length,
        25,
      );
      assert.ok(
        fork
          .getBranch()
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === "enter",
          ),
      );
      successor = await runtime(fork, f.path, c.herdr, "target:fresh");
      await successor.command("worktree-continue", state.id);
      assert.equal(successor.prompts.length, 1);
      assert.equal(worktreeState(fork.getBranch())?.kind, "owned");
      await successor.command("worktree-continue", state.id);
      assert.equal(successor.prompts.length, 1);
      sent();
    },
  });
  const source = await runtime(f.session, f.dir, c.herdr);
  assert.equal(source.tool.exposure, "model-only");
  assert.equal(source.tool.executionMode, "sequential");
  const turn = await source.enter();
  assert.equal(turn.result.terminate, true);
  assert.equal(c.calls.length, 0);
  const finished = turn.finish();
  await launched;
  assert.equal(source.controls.shutdown, 0);
  assert.ok(successor);
  const state = worktreeState(f.session.getBranch());
  assert.ok(state && state.kind === "launching");
  const resumedSuccessor = SessionManager.open(f.sessionFile);
  assert.equal(worktreeState(resumedSuccessor.getBranch())?.kind, "launching");
  await assert.rejects(readFile(join(state.destination.claimPath, "decision")), /ENOENT/);
  await successor.command("worktree-continue", state.id);
  assert.equal(successor.prompts.length, 1);
  await successor.runner.emit({ type: "agent_start" });
  await finished;
  await successor.runner.emit({ type: "session_start", reason: "reload" });
  assert.equal(successor.prompts.length, 1);
  assert.equal(source.controls.shutdown, 1);
  assert.equal(source.controls.aborted, 1);
  assert.equal(worktreeState(f.session.getBranch())?.kind, "transferred");
  assert.equal((await successor.enter()).result.terminate, undefined);
  assert.equal(c.calls.filter((method) => method === "pane.send_input").length, 1);
  assert.ok(!c.calls.includes("tab.close"));
  assert.deepEqual(source.errors, []);
});

test("unsaved, failed, and aborted tool results never launch or lose the source", async (t) => {
  for (const options of [
    { persist: false },
    { isError: true },
    { outcome: "aborted" } satisfies { outcome: AgentActivityOutcome },
  ]) {
    const f = await fixture(t);
    const c = client(f.path);
    const source = await runtime(f.session, f.dir, c.herdr);
    await (await source.enter()).finish(options);
    assert.equal(c.calls.length, 0);
    assert.equal(source.controls.shutdown, 0);
    assert.equal(worktreeState(f.session.getBranch())?.kind, "stopped");
    assert.ok(source.notifications.length);
  }
});

test("launch failures persist stopped state and reload cannot spawn or execute more tools", async (t) => {
  const f = await fixture(t);
  const c = client(f.path, {
    send: async () => {
      throw new Error("shell unavailable");
    },
  });
  const source = await runtime(f.session, f.dir, c.herdr);
  await (await source.enter()).finish();
  assert.equal(source.controls.shutdown, 0);
  assert.equal(worktreeState(f.session.getBranch())?.kind, "stopped");
  const restored = await runtime(SessionManager.open(f.sessionFile), f.dir, c.herdr);
  await restored.runner.emit({ type: "session_start", reason: "reload" });
  const blocked = await restored.runner.emitToolCall({
    type: "tool_call",
    toolCallId: "other",
    toolName: "read",
    input: { path: "file" },
  });
  assert.equal(blocked?.block, true);
  assert.equal(blocked?.terminate, true);
  await restored.command("worktree", "task");
  assert.equal(c.calls.filter((method) => method === "pane.send_input").length, 1);
});

test("a target outside a Git work tree fails the tool call before any handoff state exists", async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const c = client(f.path);
  const source = await runtime(f.session, outside, c.herdr);
  await assert.rejects(
    source.tool.execute(
      "enter",
      { branch: "task" },
      undefined,
      undefined,
      source.runner.createToolContext("enter", undefined),
    ),
    /not inside a Git work tree/,
  );
  assert.equal(
    f.session
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === HANDOFF_ENTRY).length,
    0,
  );
  assert.equal(handoffBlock(f.session, outside), undefined);
});

test("a checkout passed as cwd targets its repository, not the session directory", async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const c = client(f.path, {
    send: async () => {
      const state = worktreeState(f.session.getBranch());
      if (state?.kind !== "launching")
        throw new Error(`expected a launching handoff, got ${state?.kind}`);
      await new HandoffReadiness(state.destination.claimPath, state.id).decide("ready");
    },
  });
  const source = await runtime(f.session, outside, c.herdr);
  await (await source.enter({ branch: "task", cwd: f.dir })).finish();
  assert.equal(worktreeState(f.session.getBranch())?.kind, "transferred");
});

test("startup timeout keeps the source alive and rejects a late successor", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture(t);
  let sent: () => void = () => {};
  const launched = new Promise<void>((resolve) => {
    sent = resolve;
  });
  let successor: Awaited<ReturnType<typeof runtime>> | undefined;
  let successorId = "";
  const c = client(f.path, {
    send: async () => {
      const state = worktreeState(f.session.getBranch());
      assert.ok(state);
      successorId = state.id;
      const fork = SessionManager.forkFrom(f.sessionFile, f.path, join(f.dir, "successors"), {
        id: state.id,
      });
      successor = await runtime(fork, f.path, c.herdr, "target:fresh");
      sent();
    },
  });
  const source = await runtime(f.session, f.dir, c.herdr);
  const finished = (await source.enter()).finish();
  await launched;
  await setImmediate();
  t.mock.timers.tick(60_001);
  await finished;
  assert.equal(source.controls.shutdown, 0);
  assert.equal(worktreeState(f.session.getBranch())?.kind, "stopped");
  assert.ok(successor);
  await successor.command("worktree-continue", successorId);
  assert.deepEqual(successor.prompts, []);
});

test("aborting while the successor starts cancels readiness without exiting the source", async (t) => {
  const f = await fixture(t);
  let sent: () => void = () => {};
  const launched = new Promise<void>((resolve) => {
    sent = resolve;
  });
  const c = client(f.path, {
    send: async () => {
      sent();
    },
  });
  const source = await runtime(f.session, f.dir, c.herdr);
  const finished = (await source.enter()).finish();
  await launched;
  source.controls.operation.abort();
  await finished;
  const state = worktreeState(f.session.getBranch());
  assert.ok(state?.kind === "stopped" && state.destination);
  assert.equal(
    await new HandoffReadiness(state.destination.claimPath, state.id).decide("ready"),
    "stopped",
  );
  assert.equal(source.controls.shutdown, 0);
});

test("queued input, co-issued tools, and busy slash-command sources cannot move", async (t) => {
  const f = await fixture(t);
  const c = client(f.path);
  const source = await runtime(f.session, f.dir, c.herdr);
  source.controls.queued = true;
  await assert.rejects(source.enter(), /queued messages/);
  source.controls.queued = false;
  source.assistant.content.push({
    type: "toolCall",
    id: "read",
    name: "read",
    arguments: { path: "file" },
  });
  await assert.rejects(source.enter(), /alone/);
  const sibling = await source.runner.emitToolCall({
    type: "tool_call",
    toolCallId: "read",
    toolName: "read",
    input: { path: "file" },
  });
  assert.equal(sibling?.block, true);
  assert.equal(sibling?.terminate, true);
  source.controls.idle = false;
  await source.command("worktree", "task");
  assert.equal(c.calls.length, 0);
});

test("checkout ownership includes grouped and symlinked agent locations, not just the selected workspace", async (t) => {
  const f = await fixture(t);
  const alias = join(f.dir, "alias");
  await symlink(f.path, alias);
  const checkout: WorktreeWorkspace = {
    workspace,
    tab,
    root_pane: pane,
    worktree: { path: f.path },
    already_open: true,
  };
  for (const occupant of [
    { ...pane, agent: "pi" },
    { ...pane, pane_id: sourcePane.pane_id },
    { ...pane, workspace_id: "grouped", pane_id: "grouped:agent", agent: "codex", cwd: alias },
  ]) {
    const c = client(f.path, { agents: [occupant] });
    await assert.rejects(
      handoffPane(c.herdr, checkout, sourcePane.pane_id, "session.jsonl"),
      /already has an agent/,
    );
    assert.ok(!c.calls.includes("tab.create"));
    assert.ok(!c.calls.includes("pane.send_input"));
  }
});

test("a destination that becomes busy gets no launch input", async (t) => {
  for (const busy of ["agent", "process"] satisfies ("agent" | "process")[]) {
    const f = await fixture(t);
    const c = client(f.path, { busy });
    const source = await runtime(f.session, f.dir, c.herdr);
    await (await source.enter()).finish();
    assert.equal(source.controls.shutdown, 0);
    assert.equal(worktreeState(f.session.getBranch())?.kind, "stopped");
    assert.ok(!c.calls.includes("pane.send_input"));
  }
});

test("new workspaces use their owned root shell without creating another tab", async (t) => {
  const f = await fixture(t);
  const c = client(f.path);
  const checkout: WorktreeWorkspace = {
    workspace,
    tab,
    root_pane: pane,
    worktree: { path: f.path },
    already_open: false,
  };
  const destination = await handoffPane(c.herdr, checkout, "source:pane", f.sessionFile);
  assert.deepEqual(destination.pane, pane);
  assert.ok(!c.calls.includes("tab.create"));
});

test("the explicit worktree command shares readiness and source shutdown mechanics", async (t) => {
  const f = await fixture(t);
  const c = client(f.path, {
    send: async () => {
      const state = worktreeState(f.session.getBranch());
      assert.ok(state && state.kind === "launching");
      await new HandoffReadiness(state.destination.claimPath, state.id).decide("ready");
    },
  });
  const source = await runtime(f.session, f.dir, c.herdr);
  await source.command("worktree", "task");
  assert.equal(source.controls.shutdown, 1);
  assert.equal(worktreeState(f.session.getBranch())?.kind, "transferred");
  await source.command("worktree", "task");
  assert.equal(c.calls.filter((method) => method === "pane.send_input").length, 1);
});

test("concurrent checkout claims admit only one launcher and remain after restart", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    claimCheckout(f.path, "first"),
    claimCheckout(f.path, "second"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  await assert.rejects(claimCheckout(f.path, "resumed"), /reservation/);
});

test("readiness and timeout choose one atomic decision even when they race", async (t) => {
  for (const order of ["ready-first", "stopped-first", "concurrent"]) {
    const f = await fixture(t);
    const claim = await claimCheckout(f.path, "source");
    const readiness = new HandoffReadiness(claim.path, "successor");
    if (order === "ready-first") await readiness.decide("ready");
    if (order === "stopped-first") await readiness.decide("stopped");
    const results = await Promise.all([readiness.decide("ready"), readiness.decide("stopped")]);
    assert.equal(results[0], results[1]);
    if (results[0] === "ready") await readiness.wait(0);
    else await assert.rejects(readiness.wait(0), /stopped/);
  }
});

test("branch-local state ignores abandoned handoffs and rejects malformed persisted data", async (t) => {
  const f = await fixture(t);
  const before = f.session.getLeafId();
  assert.ok(before);
  const requested: WorktreeState = {
    kind: "requested",
    id: "successor",
    sourceSessionId: f.session.getSessionId(),
    sourceSessionFile: "session",
    request: { branch: "task" },
  };
  f.session.appendCustomEntry(HANDOFF_ENTRY, requested);
  assert.ok(handoffBlock(f.session, f.dir));
  f.session.branch(before);
  assert.equal(worktreeState(f.session.getBranch()), undefined);
  f.session.appendCustomEntry(HANDOFF_ENTRY, { kind: "owned", id: "successor" });
  assert.throws(() => worktreeState(f.session.getBranch()), /Invalid saved/);
});

test("resumed pending sources stop, and stale successors cannot claim or restart them", async (t) => {
  const f = await fixture(t);
  const c = client(f.path);
  const source = await runtime(f.session, f.dir, c.herdr);
  await source.enter();
  await source.runner.emit({ type: "session_start", reason: "resume" });
  assert.equal(worktreeState(f.session.getBranch())?.kind, "stopped");
  await source.command("worktree-continue", "wrong-successor");
  assert.equal(source.prompts.length, 0);
  assert.equal(c.calls.length, 0);
});

test("launch argv preserves model, reasoning, title, transcript, and isolated extensions without shell injection", async (t) => {
  const f = await fixture(t);
  const options = {
    sessionFile: "/tmp/it's $(false).jsonl",
    sessionName: "User's task",
    successorId: "successor",
    model,
    thinking: "high",
    resourceArgs: handoffResourceArgs(
      ["pi", "-ne", "-e", "./extension.ts", "--", "-e", "ignored"],
      f.dir,
    ),
  } satisfies Parameters<typeof buildPiHandoffCommand>[0];
  const { stdout } = await exec(
    "bash",
    ["-c", `pi() { printf '%s\\0' "$@"; }; ${buildPiHandoffCommand(options)}`],
    { cwd: tmpdir() },
  );
  assert.deepEqual(stdout.split("\0").slice(0, -1), [
    "-ne",
    "-e",
    join(f.dir, "extension.ts"),
    "--fork",
    options.sessionFile,
    "--session-id",
    "successor",
    "--provider",
    model.provider,
    "--model",
    model.id,
    "--thinking",
    "high",
    "--name",
    options.sessionName,
    "--",
    "/worktree-continue successor",
  ]);
  for (const [input, expected] of [
    [" task ", "daniel/task"],
    ["feature/custom", "feature/custom"],
  ])
    assert.equal(worktreeBranchFromArg(input), expected);
});

test("explicit CLI tool permissions and project trust reach the successor unchanged", async (t) => {
  const f = await fixture(t);
  for (const restrictions of [
    ["--tools", "read,worktree_enter", "--exclude-tools", "bash,write"],
    ["-t", "read,worktree_enter", "-xt", "bash,write"],
    ["--no-tools", "--tools", "worktree_enter"],
    ["-nt", "-t", "worktree_enter"],
    ["--no-builtin-tools"],
    ["-nbt"],
    ["--no-approve", "--tools", "read,worktree_enter"],
    ["-na", "-t", "read,worktree_enter"],
    ["--approve", "--exclude-tools", "bash"],
    ["-a", "-xt", "bash"],
    ["--tools", ""],
    ["--tools", "read", "--tools", "read,worktree_enter", "-xt", "bash"],
  ]) {
    const options = {
      sessionFile: f.sessionFile,
      sessionName: undefined,
      successorId: "successor",
      model,
      thinking: "high",
      resourceArgs: handoffResourceArgs(["pi", ...restrictions, "--", "--tools", "bash"], f.dir),
    } satisfies Parameters<typeof buildPiHandoffCommand>[0];
    const { stdout } = await exec("bash", [
      "-c",
      `pi() { printf '%s\\0' "$@"; }; ${buildPiHandoffCommand(options)}`,
    ]);
    const launched = stdout.split("\0").slice(0, -1);
    assert.deepEqual(launched.slice(0, restrictions.length), restrictions);
    const sourceArgs = parseArgs(restrictions);
    const successorArgs = parseArgs(launched);
    for (const key of ["tools", "excludeTools", "noTools", "noBuiltinTools"] as const)
      assert.deepEqual(successorArgs[key], sourceArgs[key]);
  }
});

test("an unrelated vanished agent cwd does not block handoff or hide a target owner", async (t) => {
  const f = await fixture(t);
  const stale = {
    ...pane,
    workspace_id: "grouped",
    pane_id: "grouped:stale",
    agent: "pi",
    cwd: join(f.dir, "gone"),
  };
  const checkout: WorktreeWorkspace = {
    workspace,
    tab,
    root_pane: pane,
    worktree: { path: f.path },
    already_open: false,
  };
  const c = client(f.path, { agents: [stale] });
  await handoffPane(c.herdr, checkout, "source:pane", f.sessionFile);
  const owner = {
    ...pane,
    workspace_id: "grouped",
    pane_id: "grouped:owner",
    agent: "pi",
    cwd: f.path,
    foreground_cwd: stale.cwd,
  };
  await assert.rejects(
    handoffPane(
      client(f.path, { agents: [stale, owner] }).herdr,
      checkout,
      "source:pane",
      f.sessionFile,
    ),
    /already has an agent/,
  );
});

test("fresh shells get a bounded initialization window before launch", async (t) => {
  const f = await fixture(t);
  const c = client(f.path, {
    initializing: 2,
    send: async () => {
      const state = worktreeState(f.session.getBranch());
      assert.ok(state?.kind === "launching");
      await new HandoffReadiness(state.destination.claimPath, state.id).decide("ready");
    },
  });
  const source = await runtime(f.session, f.dir, c.herdr);
  await (await source.enter()).finish();
  assert.equal(c.calls.filter((call) => call === "pane.process_info").length, 3);
  assert.equal(c.calls.filter((call) => call === "pane.send_input").length, 1);
  assert.equal(source.controls.shutdown, 1);
});

test("no-send failures release their own claim, including tab creation failures", async (t) => {
  for (const options of [{ busy: "process" } as const, { tabFailure: true }]) {
    const f = await fixture(t);
    const c = client(f.path, options);
    const source = await runtime(f.session, f.dir, c.herdr);
    await (await source.enter()).finish();
    assert.ok(!c.calls.includes("pane.send_input"));
    const replacement = await claimCheckout(f.path, "replacement");
    await releaseCheckout(replacement);
    assert.equal(source.controls.shutdown, 0);
  }
});

test("uncertain sends retain their claim and a late successor cannot admit another launcher", async (t) => {
  const f = await fixture(t);
  const c = client(f.path, {
    send: async () => {
      throw new Error("unknown delivery");
    },
  });
  const source = await runtime(f.session, f.dir, c.herdr);
  await (await source.enter()).finish();
  const state = worktreeState(f.session.getBranch());
  assert.ok(state?.kind === "stopped" && state.destination);
  assert.ok(await readFile(join(state.destination.claimPath, "owner"), "utf8"));
  const checkout: WorktreeWorkspace = {
    workspace,
    tab,
    root_pane: pane,
    worktree: { path: f.path },
    already_open: true,
  };
  await assert.rejects(
    handoffPane(
      c.herdr,
      checkout,
      "another:pane",
      f.sessionFile,
      undefined,
      undefined,
      fixtureForeground,
    ),
    /reservation/,
  );
  assert.equal(c.calls.filter((call) => call === "pane.send_input").length, 1);
});

test("completed unoccupied handoffs allow re-entry but concurrent launchers still have one winner", async (t) => {
  const f = await fixture(t);
  const c = client(f.path, {
    send: async () => {
      const state = worktreeState(f.session.getBranch());
      assert.ok(state?.kind === "launching");
      await new HandoffReadiness(state.destination.claimPath, state.id).decide("ready");
    },
  });
  const source = await runtime(f.session, f.dir, c.herdr);
  await (await source.enter()).finish();
  const checkout: WorktreeWorkspace = {
    workspace,
    tab,
    root_pane: pane,
    worktree: { path: f.path },
    already_open: true,
  };
  await assert.rejects(
    handoffPane(
      client(f.path, { agents: [{ ...pane, agent: "pi" }] }).herdr,
      checkout,
      "another:pane",
      f.sessionFile,
    ),
    /already has an agent/,
  );
  await assert.rejects(
    handoffPane(
      client(f.path, { busy: "process" }).herdr,
      checkout,
      "another:pane",
      f.sessionFile,
      undefined,
      undefined,
      fixtureForeground,
    ),
    /uncertain live ownership/,
  );
  const results = await Promise.allSettled([
    handoffPane(
      c.herdr,
      checkout,
      "another:pane",
      f.sessionFile,
      undefined,
      undefined,
      fixtureForeground,
    ),
    handoffPane(
      c.herdr,
      checkout,
      "another:pane",
      f.sessionFile,
      undefined,
      undefined,
      fixtureForeground,
    ),
  ]);
  const wins = results.filter((result) => result.status === "fulfilled");
  assert.equal(wins.length, 1);
  for (const win of wins) if (win.status === "fulfilled") await releaseCheckout(win.value.claim);
});

test("cancellation after acknowledged readiness persists transferred rather than stopped", async (t) => {
  const f = await fixture(t);
  let source: Awaited<ReturnType<typeof runtime>>;
  const c = client(f.path, {
    send: async () => {
      const state = worktreeState(f.session.getBranch());
      assert.ok(state?.kind === "launching");
      await new HandoffReadiness(state.destination.claimPath, state.id).decide("ready");
      source.controls.operation.abort();
    },
  });
  source = await runtime(f.session, f.dir, c.herdr);
  await (await source.enter()).finish();
  assert.equal(worktreeState(f.session.getBranch())?.kind, "transferred");
  assert.equal(worktreeState(SessionManager.open(f.sessionFile).getBranch())?.kind, "transferred");
});

test("designated successors suppress the source warning and destinationless stops offer tree recovery", async (t) => {
  const f = await fixture(t);
  const claim = await claimCheckout(f.path, f.sessionFile, undefined, { id: "successor" });
  const state: WorktreeState = {
    kind: "launching",
    id: "successor",
    sourceSessionId: f.session.getSessionId(),
    sourceSessionFile: f.sessionFile,
    request: { branch: "daniel/task" },
    destination: {
      path: f.path,
      workspaceId: "target",
      paneId: "target:fresh",
      claimPath: claim.path,
    },
  };
  f.session.appendCustomEntry(HANDOFF_ENTRY, state);
  const fork = SessionManager.forkFrom(f.sessionFile, f.path, join(f.dir, "successors"), {
    id: state.id,
  });
  const c = client(f.path);
  const successor = await runtime(fork, f.path, c.herdr, "target:fresh");
  await successor.runner.emit({ type: "session_start", reason: "reload" });
  assert.deepEqual(successor.notifications, []);
  assert.equal(worktreeState(fork.getBranch())?.kind, "launching");
  f.session.appendCustomEntry(HANDOFF_ENTRY, {
    ...state,
    kind: "stopped",
    destination: null,
    reason: "not launched",
  } satisfies WorktreeState);
  const guidance = handoffBlock(f.session, f.dir);
  assert.ok(guidance);
  assert.ok(guidance.includes("/tree") && guidance.includes("/new"));
  assert.ok(!guidance.includes("Use the destination session"));
});

test("canonical missing target subdirectories retain ownership and filesystem access errors propagate", async (t) => {
  const f = await fixture(t);
  const alias = join(f.dir, "alias");
  await symlink(f.path, alias);
  const checkout: WorktreeWorkspace = {
    workspace,
    tab,
    root_pane: pane,
    worktree: { path: f.path },
    already_open: false,
  };
  const owner = {
    ...pane,
    workspace_id: "grouped",
    pane_id: "grouped:owner",
    agent: "pi",
    foreground_cwd: join(alias, "vanished"),
  };
  await assert.rejects(
    handoffPane(client(f.path, { agents: [owner] }).herdr, checkout, "source:pane", f.sessionFile),
    /already has an agent/,
  );
  const blocked = join(f.dir, "blocked");
  await mkdir(join(blocked, "child"), { recursive: true });
  await chmod(blocked, 0);
  try {
    const denied = { ...owner, foreground_cwd: join(blocked, "child") };
    await assert.rejects(
      handoffPane(
        client(f.path, { agents: [denied] }).herdr,
        checkout,
        "source:pane",
        f.sessionFile,
      ),
      { code: "EACCES" },
    );
  } finally {
    await chmod(blocked, 0o700);
  }
});

test("initialization timeout sends nothing and releases the unused reservation", async (t) => {
  const f = await fixture(t);
  const c = client(f.path, { initializing: Infinity });
  const source = await runtime(f.session, f.dir, c.herdr);
  await (await source.enter()).finish();
  assert.ok(!c.calls.includes("pane.send_input"));
  assert.equal(source.controls.shutdown, 0);
  assert.equal(worktreeState(f.session.getBranch())?.kind, "stopped");
  const replacement = await claimCheckout(f.path, "replacement");
  await releaseCheckout(replacement);
});

test("partial owner-write failures remove only the newly created reservation", async (t) => {
  const f = await fixture(t);
  const original = fs.writeFile;
  const writer = t.mock.method(
    fs,
    "writeFile",
    async (...args: Parameters<typeof fs.writeFile>) => {
      if (typeof args[0] === "string" && args[0].endsWith("/owner")) {
        await original(args[0], "partial", { flag: "wx" });
        throw Object.assign(new Error("owner write failed"), { code: "EIO" });
      }
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(claimCheckout(f.path, f.sessionFile), { code: "EIO" });
  } finally {
    writer.mock.restore();
    syncBuiltinESMExports();
  }
  const replacement = await claimCheckout(f.path, f.sessionFile);
  await releaseCheckout(replacement);
});

test("tool-looking values of other CLI options cannot override the source permission allowlist", () => {
  for (const flag of [
    "--append-system-prompt",
    "--system-prompt",
    "--name",
    "-n",
    "--skill",
    "--prompt-template",
    "--theme",
  ]) {
    const source = ["--tools", "read,worktree_enter", flag, "--tools", "bash"];
    const forwarded = handoffResourceArgs(source, tmpdir());
    assert.deepEqual(forwarded, ["--tools", "read,worktree_enter"]);
    assert.deepEqual(parseArgs(forwarded).tools, parseArgs(source).tools);
  }
});

test("reservation cleanup rejects changed ownership and unknown files without deleting them", async (t) => {
  const f = await fixture(t);
  const claim = await claimCheckout(f.path, f.sessionFile);
  await assert.rejects(releaseCheckout({ ...claim, id: "another-operation" }), /ownership changed/);
  const originalOwner = await readFile(join(claim.path, "owner"), "utf8");
  await fs.writeFile(join(claim.path, "unexpected"), "preserve");
  await assert.rejects(releaseCheckout(claim), /pending files/);
  assert.equal(await readFile(join(claim.path, "unexpected"), "utf8"), "preserve");
  assert.equal(await readFile(join(claim.path, "owner"), "utf8"), originalOwner);
});
