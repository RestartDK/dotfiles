import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { watch } from "node:fs/promises";
import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  CombinedAutocompleteProvider,
  ProcessTerminal,
  TuiMainScreen,
  visibleWidth,
  type Component,
  type EditorComponent,
} from "@earendil-works/pi-tui";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getSelectListTheme,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import cachedModels from "./cached-models";

import { KeybindingsManager } from "../../dist/core/keybindings.js";

const profiles = process.env.PI_POLICY_TEST_PROFILES;
const extension = process.env.PI_POLICY_TEST_EXTENSION;
if (!profiles || !extension) throw new Error("Missing dispatch test profiles or extension");
const launches = spyOn(childProcess, "spawn");
const originalEnv = { ...process.env };
const originalArgv = [...process.argv];
const originalFetch = globalThis.fetch;
const network = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async () => {
      throw new Error("Unexpected HTTP request");
    },
    { preconnect: originalFetch.preconnect },
  ),
);
const originalWebSocket = globalThis.WebSocket;
let socketCalls = 0;
globalThis.WebSocket = new Proxy(originalWebSocket, {
  construct() {
    socketCalls++;
    throw new Error("Unexpected WebSocket request");
  },
});
let directory: string;
let manager: SessionManager;
const sessions: AgentSession[] = [];

function profile(name: "work" | "personal") {
  writeFileSync(
    join(directory, "config/dstack/models.json"),
    readFileSync(join(profiles ?? "", `${name}.json`)),
  );
}
function calls(kind: "auth" | "workers"): unknown[] {
  return readFileSync(join(directory, `${kind}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function tool(session: AgentSession, name = "subagents") {
  const registered = session.agent.state.tools.find((entry) => entry.name === name);
  if (!registered) throw new Error(`Actual extension did not register ${name}`);
  return registered;
}
async function create(manager: SessionManager, powerline = false) {
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, "agent"),
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [
      extension ?? "",
      ...(powerline ? [join(dirname(extension ?? ""), "../pi-prompt/index.ts")] : []),
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: join(directory, "agent/models.json"),
  });
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: join(directory, "agent"),
    settingsManager,
    resourceLoader,
    sessionManager: manager,
    modelRuntime,
    tools: ["subagents", "subagents_runs"],
  });
  sessions.push(session);
  return session;
}
async function captureFleet(session: AgentSession) {
  initTheme("dark", false);
  const ui = session.extensionRunner.createContext().ui;
  const above = new Map<string, Component>();
  const below = new Map<string, Component>();
  let editor: EditorComponent | undefined;
  const statuses = new Map<string, string>();
  const footerData = {
    getGitBranch: () => null,
    getAvailableProviderCount: () => 0,
    getExtensionStatuses: () => statuses,
    onBranchChange: () => () => {},
    setExtensionStatus(key: string, value: string | undefined) {
      if (value === undefined) statuses.delete(key);
      else statuses.set(key, value);
    },
  };
  const view = {
    width: 80,
    status: "",
    onChange: () => {},
    notices: [] as { text: string; type: string | undefined }[],
    get editor() {
      return editor;
    },
    get lines() {
      return above.get("subagents-fleet")?.render(this.width) ?? [];
    },
    get text() {
      return stripVTControlCharacters(this.lines.join("\n"));
    },
    get screen() {
      return stripVTControlCharacters(
        [
          ...[...above.values()].flatMap((component) => component.render(this.width)),
          ...(editor?.render(this.width) ?? []),
          ...[...below.values()].flatMap((component) => component.render(this.width)),
        ].join("\n"),
      );
    },
  };
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => view.onChange();
  await session.bindExtensions({
    mode: "tui",
    onError(error) {
      throw new Error(JSON.stringify(error));
    },
    uiContext: {
      ...ui,
      notify(text, type) {
        view.notices.push({ text, type });
      },
      setStatus(key, text) {
        footerData.setExtensionStatus(key, text);
        if (key === "subagents-fleet") view.status = stripVTControlCharacters(text ?? "");
      },
      setWidget(key, content, options) {
        if (Array.isArray(content)) throw new Error("Expected a responsive TUI component");
        above.delete(key);
        below.delete(key);
        const component = content?.(tui, ui.theme);
        if (component) (options?.placement === "belowEditor" ? below : above).set(key, component);
        view.onChange();
      },
      setFooter(factory) {
        factory?.(tui, ui.theme, footerData);
      },
      setEditorComponent(factory) {
        editor = factory?.(
          tui,
          { borderColor: (text) => ui.theme.fg("border", text), selectList: getSelectListTheme() },
          new KeybindingsManager(),
        );
        editor?.setAutocompleteProvider?.(new CombinedAutocompleteProvider([], directory));
      },
    },
  });
  return view;
}

async function blocked(session: AgentSession) {
  const entries = manager.getEntries();
  await expect(
    tool(session).execute("dispatch-denied", {
      agent: "dstack-agent",
      role: "feature",
      task: "WORK_HISTORY_MARKER",
      tools: [],
    }),
  ).rejects.toThrow(
    "AI policy cannot resume history with a different or unknown profile. Start a new session",
  );
  expect(launches).not.toHaveBeenCalled();
  expect(calls("auth").length).toBe(0);
  expect(calls("workers").length).toBe(0);
  expect(manager.getEntries()).toEqual(entries);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-dispatch-policy-"));
  process.env.HOME = directory;
  process.env.XDG_CONFIG_HOME = join(directory, "config");
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.env.PI_DISPATCH_TEST_DIR = directory;
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  process.argv[1] = join(import.meta.dir, "dispatch-child.ts");
  for (const path of ["config/dstack", "agent", ".agents/agents"])
    mkdirSync(join(directory, path), { recursive: true });
  writeFileSync(
    join(directory, "agent/models-store.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(cachedModels).map(([provider, models]) => [
          provider,
          { models, checkedAt: Date.now(), lastModified: Date.now() },
        ]),
      ),
    ),
  );
  writeFileSync(
    join(directory, ".agents/agents/dstack-agent.md"),
    "---\nname: dstack-agent\ndescription: Fixture worker\n---\nReturn the fixture marker.\n",
  );
  for (const kind of ["auth", "workers"]) writeFileSync(join(directory, `${kind}.jsonl`), "");
  profile("work");
  manager = SessionManager.inMemory(directory);
  launches.mockClear();
  network.mockClear();
  socketCalls = 0;
});
afterEach(async () => {
  try {
    for (const session of sessions.splice(0)) {
      await tool(session, "subagents_runs").execute("cleanup-stop", { action: "stop" });
      await tool(session, "subagents_runs").execute("cleanup-join", { action: "join" });
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    expect(network).not.toHaveBeenCalled();
    expect(socketCalls).toBe(0);
  } finally {
    process.argv = [...originalArgv];
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(directory, { recursive: true, force: true });
  }
});
afterAll(() => {
  launches.mockRestore();
  network.mockRestore();
  globalThis.WebSocket = originalWebSocket;
});

for (const name of ["work", "personal"] satisfies ("work" | "personal")[]) {
  test(`${name} parent rejects new dispatch after global profile flip`, async () => {
    profile(name);
    const session = await create(manager);
    manager.appendMessage({ role: "user", content: "WORK_HISTORY_MARKER", timestamp: Date.now() });
    profile(name === "work" ? "personal" : "work");
    await blocked(session);
  });
  test(`${name} unchanged session dispatches its declared role`, async () => {
    profile(name);
    const session = await create(manager);
    const result = await tool(session).execute("dispatch-allowed", {
      agent: "dstack-agent",
      role: "feature",
      task: "UNCHANGED_PROFILE",
      tools: [],
    });
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("1/1 succeeded") }),
    ]);
    expect(launches).toHaveBeenCalledTimes(2);
    expect(calls("auth").length).toBe(1);
    expect(calls("workers")).toEqual([
      {
        invocation: {
          profile: name,
          selection: {
            kind: "role",
            role: "feature",
            member: name === "work" ? "astra" : "deepseek",
          },
          attempt: 0,
        },
        task: "Delegated task:\n\nUNCHANGED_PROFILE",
      },
    ]);
  });
}

for (const history of [false, true]) {
  test(`unmarked session rejects dispatch with history=${history}`, async () => {
    const session = await create(manager);
    manager.newSession();
    if (history)
      manager.appendMessage({ role: "user", content: "UNKNOWN_HISTORY", timestamp: Date.now() });
    await blocked(session);
  });
}
for (const marker of [
  null,
  {},
  { profile: "unknown" },
  { profile: 1 },
  ["work"],
  { profile: "personal" },
]) {
  test(`invalid marker ${JSON.stringify(marker)} rejects dispatch despite earlier valid marker`, async () => {
    const session = await create(manager);
    manager.appendCustomEntry("dstack-model-policy", marker);
    await blocked(session);
  });
}

test("stale session can join an existing background dispatch", async () => {
  const session = await create(manager);
  await tool(session).execute("background", {
    role: "feature",
    task: "BACKGROUND_JOIN",
    tools: [],
    background: true,
  });
  profile("personal");
  const status = await tool(session, "subagents_runs").execute("status", { action: "status" });
  expect(status.content).toEqual([
    expect.objectContaining({ text: expect.stringContaining("BACKGROUND_JOIN") }),
  ]);
  const result = await tool(session, "subagents_runs").execute("join", { action: "join" });
  expect(result.content).toEqual([
    expect.objectContaining({ text: expect.stringContaining("1/1 succeeded") }),
  ]);
  expect(calls("auth").length).toBe(1);
  expect(calls("workers").length).toBe(1);
});

test("stale session can stop and join an existing running dispatch", async () => {
  const session = await create(manager);
  const watcher = watch(join(directory, "workers.jsonl"), { signal: AbortSignal.timeout(5000) });
  const started = (async () => {
    for await (const _event of watcher) if (calls("workers").length > 0) return;
  })();
  await tool(session).execute("background", {
    role: "feature",
    task: "HOLD_UNTIL_STOP",
    tools: [],
    background: true,
  });
  await started;
  profile("personal");
  const stopped = await tool(session, "subagents_runs").execute("stop", { action: "stop" });
  expect(stopped.content).toEqual([
    expect.objectContaining({ text: expect.stringContaining("SIGTERM sent") }),
  ]);
  const joined = await tool(session, "subagents_runs").execute("join", { action: "join" });
  expect(joined.content).toEqual([
    expect.objectContaining({ text: expect.stringContaining("Cancelled by parent") }),
  ]);
  expect(calls("auth").length).toBe(1);
  expect(calls("workers").length).toBe(1);
});

test("foreground workers use native activity, resize safely, and never become background handles", async () => {
  const session = await create(manager);
  const view = await captureFleet(session);
  const abort = new AbortController();
  const active = new Promise<void>((resolve) => {
    view.onChange = () => {
      if (view.text.includes("working")) resolve();
    };
  });
  const pending = tool(session).execute(
    "foreground",
    {
      role: "feature",
      label: "Inspect 漢字 auth\n\u001b[2Jmodule",
      task: "HOLD_UNTIL_STOP",
      tools: [],
    },
    abort.signal,
  );
  try {
    await active;
    expect(view.status).toContain("● 1");
    for (const width of [4, 12, 30, 48, 80, 120]) {
      view.width = width;
      expect(view.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    view.width = 80;
    expect(view.text).toContain("Inspect 漢字 auth module");
    expect(view.text).toContain("Astra");
    const status = await tool(session, "subagents_runs").execute("status", { action: "status" });
    expect(status.content).toEqual([{ type: "text", text: "No background runs." }]);
  } finally {
    abort.abort();
    await pending;
  }
  expect(view.text).toContain("stopped");
  await session.prompt("/subagents clear");
  expect(view.lines).toEqual([]);
  expect(view.status).toBe("");
});

test("background success stays visible until joined, then clears widget and status", async () => {
  const session = await create(manager);
  const view = await captureFleet(session);
  const finished = new Promise<void>((resolve) => {
    view.onChange = () => {
      if (view.text.includes("1 done")) resolve();
    };
  });
  await tool(session).execute("background", {
    role: "feature",
    task: "BACKGROUND_UI",
    tools: [],
    background: true,
  });
  await finished;
  expect(view.status).toContain("✓ 1");
  await tool(session, "subagents_runs").execute("join", { action: "join" });
  expect(view.lines).toEqual([]);
  expect(view.status).toBe("");
});

test("foreground history cannot evict uncollected background results or grow the panel without bound", async () => {
  const session = await create(manager);
  const view = await captureFleet(session);
  const finished = new Promise<void>((resolve) => {
    view.onChange = () => {
      if (view.text.includes("1 done")) resolve();
    };
  });
  await tool(session).execute("background", {
    role: "feature",
    task: "RETAIN_BACKGROUND_RESULT",
    tools: [],
    background: true,
  });
  await finished;
  let overflowShown = false;
  view.onChange = () => {
    if (view.text.includes("more")) overflowShown = true;
    expect(view.lines.length).toBeLessThanOrEqual(8);
  };
  for (let batch = 0; batch < 2; batch++) {
    await tool(session).execute(`foreground-${batch}`, {
      tasks: Array.from({ length: 8 }, () => ({
        role: "feature",
        task: "FOREGROUND_RESULT",
        tools: [],
      })),
    });
  }
  expect(overflowShown).toBe(true);
  const joined = await tool(session, "subagents_runs").execute("join", { action: "join" });
  expect(joined.content).toEqual([
    expect.objectContaining({ text: expect.stringContaining("1/1 succeeded") }),
  ]);
  expect(view.lines).toEqual([]);
});

test("view changes hide presentation without stopping workers or rewriting worker settings", async () => {
  const settingsPath = join(directory, "agent/settings.json");
  const settings = JSON.stringify({ subagents: { maxParallel: 1 }, theme: "dark" });
  writeFileSync(settingsPath, settings);
  const session = await create(manager);
  const view = await captureFleet(session);
  await tool(session).execute("background", {
    role: "feature",
    task: "HOLD_UNTIL_STOP",
    tools: [],
    background: true,
  });
  for (const mode of ["status", "off", "panel"]) {
    await session.prompt(`/subagents view ${mode}`);
    expect(view.lines.length > 0).toBe(mode === "panel");
    expect(view.status.length > 0).toBe(mode !== "off");
    const status = await tool(session, "subagents_runs").execute("status", { action: "status" });
    expect(status.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("running") }),
    ]);
    expect(JSON.parse(readFileSync(join(directory, "agent/subagents.json"), "utf8"))).toEqual({
      view: mode,
    });
  }
  expect(readFileSync(settingsPath, "utf8")).toBe(settings);
  await session.prompt("/subagents view invalid");
  await session.prompt("/subagents view off extra");
  expect(view.lines.length).toBeGreaterThan(0);
  expect(JSON.parse(readFileSync(join(directory, "agent/subagents.json"), "utf8"))).toEqual({
    view: "panel",
  });
});

test.each(["panel", "status", "off"])(
  "saved %s view is restored in a fresh extension instance",
  async (mode) => {
    const first = await create(manager);
    await captureFleet(first);
    await first.prompt(`/subagents view ${mode}`);
    await first.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    const restored = await create(SessionManager.inMemory(directory));
    const view = await captureFleet(restored);
    await tool(restored).execute("background", {
      role: "feature",
      task: "HOLD_UNTIL_STOP",
      tools: [],
      background: true,
    });
    expect(view.lines.length > 0).toBe(mode === "panel");
    expect(view.status.length > 0).toBe(mode !== "off");
  },
);

test("failed preference writes apply the view for this session and report that it was not saved", async () => {
  const session = await create(manager);
  const view = await captureFleet(session);
  mkdirSync(join(directory, "agent/subagents.json"));
  await tool(session).execute("background", {
    role: "feature",
    task: "HOLD_UNTIL_STOP",
    tools: [],
    background: true,
  });
  await session.prompt("/subagents view off");
  expect(view.lines).toEqual([]);
  expect(view.status).toBe("");
  expect(view.notices.at(-1)).toMatchObject({
    type: "warning",
    text: expect.stringContaining("session only"),
  });
});

test("powerline stays attached to the prompt when the worker panel is remounted and clicks still reach the editor", async () => {
  mkdirSync(join(directory, ".pi/agent"), { recursive: true });
  writeFileSync(
    join(directory, ".pi/agent/settings.json"),
    JSON.stringify({
      powerline: { preset: "minimal", fixedEditor: false },
      powerlineWelcome: false,
    }),
  );
  const session = await create(manager, true);
  const view = await captureFleet(session);
  await tool(session).execute("background", {
    role: "feature",
    task: "HOLD_UNTIL_STOP",
    tools: [],
    background: true,
  });
  for (let remount = 0; remount < 2; remount++) {
    const screen = view.screen;
    expect(screen.indexOf("Subagents")).toBeGreaterThanOrEqual(0);
    expect(screen.indexOf(basename(directory))).toBeGreaterThan(screen.indexOf("Subagents"));
    await session.prompt("/subagents view off");
    expect(view.screen).not.toContain("Subagents");
    await session.prompt("/subagents view panel");
  }
  const editor = view.editor;
  if (!editor) throw new Error("Missing powerline editor");
  editor.setText("hello");
  const lines = editor.render(80).map(stripVTControlCharacters);
  const textRow = lines.findIndex((line) => line.includes("> hello"));
  expect(textRow).toBeGreaterThan(1);
  const mouse = {
    type: "click" as const,
    button: "left" as const,
    x: 3,
    y: 0,
    screenX: 3,
    screenY: 0,
    width: 80,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
  };
  editor.handleMouse?.(mouse);
  editor.handleInput("X");
  expect(editor.getText()).toBe("helloX");
  editor.setText("hello");
  editor.render(80);
  editor.handleMouse?.({ ...mouse, y: textRow, screenY: textRow });
  editor.handleInput("X");
  expect(editor.getText()).toBe("Xhello");
});

test("compact tool results keep full reports accessible through Pi's expansion control", async () => {
  const session = await create(manager);
  const view = await captureFleet(session);
  const args = { role: "feature", label: "Render report", task: "REPORT_RESULT", tools: [] };
  const result = await tool(session).execute("report", args);
  expect(view.lines).toEqual([]);
  const tui = new TuiMainScreen(new ProcessTerminal());
  tui.requestRender = () => {};
  const row = new ToolExecutionComponent(
    "subagents",
    "report",
    args,
    undefined,
    session.extensionRunner.getToolDefinition("subagents"),
    tui,
    directory,
  );
  row.markExecutionStarted();
  row.setArgsComplete();
  row.updateResult({ ...result, isError: false });
  expect(stripVTControlCharacters(row.render(80).join("\n"))).toContain("Render report");
  expect(row.render(80).join("\n")).not.toContain("DISPATCH_FIXTURE_ONLY");
  row.setExpanded(true);
  expect(row.render(80).join("\n")).toContain("DISPATCH_FIXTURE_ONLY");
});

test("foreground failures survive result collection and session shutdown removes the panel", async () => {
  const session = await create(manager);
  const view = await captureFleet(session);
  const result = await tool(session).execute("failure", {
    role: "feature",
    task: "FAIL_DISPATCH",
    tools: [],
  });
  expect(result.content).toEqual([
    expect.objectContaining({ text: expect.stringContaining("Fixture failed") }),
  ]);
  expect(view.text).toContain("1 failed");
  expect(view.status).toContain("✕ 1");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  expect(view.lines).toEqual([]);
  expect(view.status).toBe("");
});

for (const marker of ["unmarked", "personal", null]) {
  test(`startup refuses ${JSON.stringify(marker)} history without rebinding`, async () => {
    if (marker !== "unmarked")
      manager.appendCustomEntry("dstack-model-policy", { profile: marker });
    manager.appendMessage({ role: "user", content: "OLD_HISTORY", timestamp: Date.now() });
    const entries = manager.getEntries();
    await expect(create(manager)).rejects.toThrow("different or unknown profile");
    expect(manager.getEntries()).toEqual(entries);
    expect(launches).not.toHaveBeenCalled();
  });
}

for (const mode of ["resume", "fork"]) {
  test(`${mode} preserves the established profile and rejects crossing it`, async () => {
    const saved = SessionManager.create(directory, join(directory, "sessions"));
    const session = await create(saved);
    const model = session.model;
    if (!model) throw new Error("Missing policy default");
    saved.appendMessage({ role: "user", content: "SAVED_WORK_HISTORY", timestamp: Date.now() });
    saved.appendMessage({
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: "Fixture" }],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        totalTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const file = saved.getSessionFile();
    if (!file) throw new Error("Missing persisted session");
    const restored =
      mode === "resume" ? SessionManager.open(file) : SessionManager.forkFrom(file, directory);
    await create(restored);
    const markers = restored
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "dstack-model-policy");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ data: { profile: "work" } });
    const entries = restored.getEntries();
    profile("personal");
    await expect(create(restored)).rejects.toThrow("different or unknown profile");
    expect(restored.getEntries()).toEqual(entries);
    expect(launches).not.toHaveBeenCalled();
  });
}
