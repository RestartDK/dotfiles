import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { watch } from "node:fs/promises";
import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

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
async function create(manager: SessionManager) {
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, "agent"),
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: [extension ?? ""],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
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
