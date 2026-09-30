import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupSessionResources,
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { toJsonEvent } from "../../dist/modes/json-event.js";
import type { NativeTarget } from "../../config/pi/agent/lib/model-policy";

const { configureInvocation } = await import("../../dist/core/dstack-policy.js");
const profiles = process.env.PI_POLICY_TEST_PROFILES;
if (!profiles) throw new Error("Missing summary retry profiles");

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const network = spyOn(globalThis, "fetch");
let directory: string;
let session: AgentSession | undefined;
let socketCalls: number;
let wires: unknown[];
const backend = {
  kind: "pi",
  provider: "openrouter",
  id: "z-ai/glm-5.3-flash",
  thinking: "xhigh",
} satisfies NativeTarget;
const assistant: AssistantMessage = {
  role: "assistant",
  provider: backend.provider,
  model: backend.id,
  api: "openai-completions",
  content: [{ type: "text", text: "Fixture partial output" }],
  stopReason: "stop",
  timestamp: 0,
  usage: {
    input: 2000000,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2000001,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

function response() {
  const chunk = {
    id: "chatcmpl_fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: backend.id,
  };
  const events = [
    {
      ...chunk,
      choices: [
        { index: 0, delta: { role: "assistant", content: "Fixture summary" }, finish_reason: null },
      ],
    },
    {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-summary-retry-"));
  process.env.HOME = directory;
  process.env.XDG_CONFIG_HOME = join(directory, "config");
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  for (const path of ["config/dstack", "agent"])
    mkdirSync(join(directory, path), { recursive: true });
  writeFileSync(
    join(directory, "config/dstack/models.json"),
    readFileSync(join(profiles ?? "", "work.json")),
  );
  configureInvocation([
    "--dstack-worker",
    JSON.stringify({
      profile: "work",
      selection: { kind: "role", role: "fast-code", member: "glm" },
      attempt: 0,
    }),
  ]);
  wires = [];
  socketCalls = 0;
  globalThis.WebSocket = new Proxy(originalWebSocket, {
    construct() {
      socketCalls++;
      throw new Error("Unexpected WebSocket request");
    },
  });
  network.mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, init);
        if (request.url !== "https://openrouter.ai/api/v1/chat/completions")
          throw new Error("Unexpected HTTP destination");
        wires.push(await request.json());
        if (wires.length === 1)
          return new Response(
            JSON.stringify({ error: { type: "rate_limit_error", message: "rate_limit_error" } }),
            {
              status: 429,
              headers: { "content-type": "application/json", "retry-after-ms": "1" },
            },
          );
        if (wires.length > 3) throw new Error("Unexpected extra inference attempt");
        return response();
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
});
afterEach(() => {
  session?.dispose();
  session = undefined;
  configureInvocation([]);
  cleanupSessionResources();
  expect(socketCalls).toBe(0);
  network.mockReset();
  globalThis.WebSocket = originalWebSocket;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(directory, { recursive: true, force: true });
});
afterAll(() => network.mockRestore());

type SummaryPath = "manual" | "threshold" | "overflow" | "branchSummary";
async function summarize(path: SummaryPath) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  await modelRuntime.setRuntimeApiKey(backend.provider, "fixture");
  const model = modelRuntime.getModel(backend.provider, backend.id);
  if (!model) throw new Error("Missing fixture model");
  const tokens = path === "threshold" ? model.contextWindow - 512 : model.contextWindow + 512;
  const history = {
    ...assistant,
    usage: { ...assistant.usage, input: tokens, totalTokens: tokens + 1 },
  };
  const manager = SessionManager.inMemory(directory);
  manager.appendCustomEntry("dstack-model-policy", { profile: "work" });
  manager.appendModelChange(backend.provider, backend.id);
  manager.appendThinkingLevelChange("xhigh");
  const target = manager.appendMessage({
    role: "user",
    content: "Old fixture ".repeat(500),
    timestamp: 0,
  });
  manager.appendMessage(history);
  manager.appendMessage({ role: "user", content: "Latest fixture ".repeat(200), timestamp: 0 });
  manager.appendMessage(history);
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
    compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 128 },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({
    cwd: directory,
    agentDir: join(directory, "agent"),
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager: manager,
    tools: [],
  }));
  const events: JsonAgentSessionEvent[] = [];
  session.subscribe((event) => events.push(toJsonEvent(event)));
  if (path === "manual") expect((await session.compact()).summary).toContain("Fixture summary");
  else if (path === "threshold" || path === "overflow") await session.prompt("Continue fixture");
  else {
    expect((await session.navigateTree(target, { summarize: true })).cancelled).toBe(false);
    const leaf = manager.getLeafEntry() as { type?: unknown; summary?: unknown } | undefined;
    expect(leaf?.type).toBe("branch_summary");
    expect(typeof leaf?.summary).toBe("string");
    expect(leaf?.summary).toContain("Fixture summary");
  }
  if (path === "manual" || path === "branchSummary") await session.prompt("Continue fixture");
  const retries = events.filter((event) => event.type.startsWith("summarization_retry_"));
  expect(retries.map((event) => event.type)).toEqual([
    "summarization_retry_scheduled",
    "summarization_retry_attempt_start",
    "summarization_retry_finished",
  ]);
  expect(retries[1]).toEqual(
    path === "branchSummary"
      ? { type: "summarization_retry_attempt_start", source: "branchSummary" }
      : { type: "summarization_retry_attempt_start", source: "compaction", reason: path },
  );
  if (path !== "branchSummary")
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "compaction_end",
        reason: path,
        aborted: false,
        result: expect.objectContaining({ summary: expect.stringContaining("Fixture summary") }),
      }),
    );
  expect(wires).toHaveLength(3);
  for (const wire of wires)
    expect(wire).toMatchObject({ model: backend.id, reasoning: { effort: "max" } });
}

for (const path of ["manual", "threshold", "overflow", "branchSummary"] satisfies SummaryPath[]) {
  test(`${path} SDK summarization retries under worker policy and effort`, async () => {
    await summarize(path);
  });
}
