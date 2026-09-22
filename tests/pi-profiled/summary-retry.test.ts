import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
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
import type { BackendTask } from "../../config/pi/agent/extensions/subagents/backend";
import { toJsonEvent } from "../../dist/modes/json-event.js";

const { configureInvocation } = await import("../../dist/core/dstack-policy.js");
const profiles = process.env.PI_POLICY_TEST_PROFILES;
const extension = process.env.PI_POLICY_TEST_EXTENSION;
if (!profiles || !extension) throw new Error("Missing summary retry profiles or extension");
const { BackendRunner }: typeof import("../../config/pi/agent/extensions/subagents/backend") =
  await import(join(dirname(extension), "backend.ts"));
const { Protocol }: typeof import("../../config/pi/agent/extensions/subagents/protocol") =
  await import(join(dirname(extension), "protocol.ts"));

const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture`;
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
  provider: "openai-codex",
  id: "gpt-5.6-sol",
  thinking: "xhigh",
} satisfies BackendTask["route"]["chain"][number];
const assistant: AssistantMessage = {
  role: "assistant",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  api: "openai-codex-responses",
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
const success: JsonAgentSessionEvent = { type: "message_end", message: assistant };
const writeEnd: JsonAgentSessionEvent = {
  type: "tool_execution_end",
  toolCallId: "write-1",
  toolName: "write",
  result: { content: [{ type: "text", text: "Wrote writes.txt" }] },
  isError: false,
};

function response() {
  const item = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Fixture summary", annotations: [] }],
  };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: item.content[0],
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "Fixture summary",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
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
  for (const path of ["auth.jsonl", "workers.jsonl", "writes.txt"])
    writeFileSync(join(directory, path), "");
  configureInvocation([
    "--dstack-worker",
    JSON.stringify({
      profile: "work",
      selection: { kind: "role", role: "precise-code", member: "sol" },
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
        if (request.url !== "https://chatgpt.com/backend-api/codex/responses")
          throw new Error("Unexpected HTTP destination");
        const body = new Uint8Array(await request.arrayBuffer());
        wires.push(
          JSON.parse(
            request.headers.get("content-encoding") === "zstd"
              ? zstdDecompressSync(body).toString()
              : new TextDecoder().decode(body),
          ),
        );
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
  await modelRuntime.setRuntimeApiKey("openai-codex", token);
  const model = modelRuntime.getModel(backend.provider, backend.id);
  if (!model) throw new Error("Missing fixture model");
  const tokens = path === "threshold" ? model.contextWindow - 512 : model.contextWindow + 512;
  const history = {
    ...assistant,
    usage: { ...assistant.usage, input: tokens, totalTokens: tokens + 1 },
  };
  const manager = SessionManager.inMemory(directory);
  manager.appendCustomEntry("dstack-model-policy", { profile: "work" });
  manager.appendModelChange("openai-codex", "gpt-5.6-sol");
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
    expect(manager.getLeafEntry()).toMatchObject({
      type: "branch_summary",
      summary: expect.stringContaining("Fixture summary"),
    });
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
  for (const wire of wires) expect(wire).toMatchObject({ reasoning: { effort: "xhigh" } });
  return { events, retries };
}
function count(file: string) {
  return readFileSync(join(directory, file), "utf8").split("\n").filter(Boolean).length;
}
async function replay(events: unknown[], options: { tools?: string[]; cancel?: boolean } = {}) {
  writeFileSync(
    join(directory, "events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  writeFileSync(
    join(directory, "fallback.jsonl"),
    JSON.stringify({ ...success, message: { ...assistant, model: "gpt-6-astra" } }) + "\n",
  );
  const runner = new BackendRunner({
    pi: (args) => ({
      command: process.execPath,
      args: [
        join(import.meta.dir, "summary-retry-child.ts"),
        directory,
        options.cancel ? "hold" : "exit",
        ...args,
      ],
    }),
    claude: () => {
      throw new Error("Unexpected Claude invocation");
    },
    env: { HOME: directory, PATH: process.env.PATH },
    now: Date.now,
  });
  const controller = new AbortController();
  try {
    return await runner.run(
      {
        route: {
          profile: "work",
          selection: { kind: "role", role: "precise-code", member: "sol" },
          chain: [backend, { ...backend, id: "gpt-6-astra" }],
        },
        task: "Replay SDK summary retry",
        tools: options.tools ?? [],
        systemPrompt: "Fixture only",
        cwd: directory,
        contextFiles: [],
      },
      controller.signal,
      (execution) => {
        if (options.cancel && execution.output) controller.abort();
      },
    );
  } finally {
    runner.stop();
  }
}

for (const path of ["manual", "threshold", "overflow", "branchSummary"] satisfies SummaryPath[]) {
  test(`${path} SDK summary retry survives JSON worker parsing`, async () => {
    const { events } = await summarize(path);
    const result = await replay(events);
    expect(result.output).toBe("Fixture summary");
    expect(result.outcome).toEqual({ kind: "success" });
    expect(result.attempts).toHaveLength(1);
    expect(count("workers.jsonl")).toBe(1);
    expect(count("auth.jsonl")).toBe(1);
    expect(count("writes.txt")).toBe(0);
  });
  test(`${path} SDK retry events preserve terminal and partial output`, async () => {
    const { retries } = await summarize(path);
    for (const stopReason of [
      "stop",
      "error",
      "aborted",
    ] satisfies AssistantMessage["stopReason"][]) {
      const protocol = new Protocol(backend, ["write"]);
      protocol.accept(writeEnd);
      protocol.accept({
        type: "message_end",
        message: { ...assistant, stopReason, errorMessage: "429 Too Many Requests" },
      });
      const terminal = protocol.terminal;
      for (const event of retries) protocol.accept(JSON.parse(JSON.stringify(event)));
      expect(protocol.terminal).toBe(terminal);
      expect(protocol.toolUsed).toBe(true);
      expect(protocol.output).toBe("Fixture partial output");
    }
    const result = await replay([success, ...retries]);
    expect(result.outcome).toEqual({ kind: "success" });
    expect(result.output).toBe("Fixture partial output");
    expect(count("workers.jsonl")).toBe(1);
  });
  for (const errorMessage of ["429 Too Many Requests", "401 Unauthorized"]) {
    for (const tools of [[], ["write"]]) {
      test(`${path} retry then ${errorMessage} with tools=${tools.length} counts actual replay`, async () => {
        const { retries } = await summarize(path);
        const error: JsonAgentSessionEvent = {
          type: "message_end",
          message: { ...assistant, stopReason: "error", errorMessage },
        };
        const result = await replay([...(tools.length ? [writeEnd] : []), ...retries, error], {
          tools,
        });
        expect(count("workers.jsonl")).toBe(tools.length ? 1 : 2);
        expect(count("auth.jsonl")).toBe(tools.length ? 1 : 2);
        expect(count("writes.txt")).toBe(tools.length);
        expect(result.attempts).toHaveLength(tools.length ? 1 : 2);
        expect(result.outcome).toEqual(
          tools.length
            ? {
                kind: "failed",
                reason: `${errorMessage.startsWith("429") ? "quota" : "auth"}. Partial output retained after tool use; parent must reconcile before retrying.`,
              }
            : { kind: "success" },
        );
        expect(result.output).toBe("Fixture partial output");
        expect(result.toolUsed).toBe(Boolean(tools.length));
      });
    }
  }
  test(`${path} retry alone cannot complete or replay a task`, async () => {
    const { retries } = await summarize(path);
    const result = await replay(retries);
    expect(result.outcome).toEqual({
      kind: "failed",
      reason: "Backend exited without a terminal result",
    });
    expect(count("workers.jsonl")).toBe(1);
    expect(count("auth.jsonl")).toBe(1);
  });
  test(`${path} retry preserves cancellation and partial output without replay`, async () => {
    const { retries } = await summarize(path);
    const result = await replay([...retries, { type: "message_start", message: assistant }], {
      cancel: true,
    });
    expect(result.outcome).toEqual({ kind: "cancelled" });
    expect(result.output).toBe("Fixture partial output");
    expect(count("workers.jsonl")).toBe(1);
  });
}
test("unknown summary event fails closed through the child parser", async () => {
  const result = await replay([{ type: "summarization_retry_future" }, success]);
  expect(result.outcome).toEqual({
    kind: "failed",
    reason: "Unknown Pi event: summarization_retry_future",
  });
  expect(count("workers.jsonl")).toBe(1);
});
