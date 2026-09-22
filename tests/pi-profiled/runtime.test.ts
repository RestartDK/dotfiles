import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  AgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

import cachedModels from "./cached-models";

const { configureInvocation } = await import("../../dist/core/dstack-policy.js");

const profiles = process.env.PI_POLICY_TEST_PROFILES;
if (!profiles) throw new Error("PI_POLICY_TEST_PROFILES must point to the committed profiles");
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture`;
const network = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async () => {
      throw new Error("Unexpected network request");
    },
    { preconnect: originalFetch.preconnect },
  ),
);
const originalWebSocket = globalThis.WebSocket;
let socketCalls = 0;
globalThis.WebSocket = new Proxy(originalWebSocket, {
  construct() {
    socketCalls++;
    throw new Error("Unexpected WebSocket connection");
  },
});
afterAll(() => {
  network.mockRestore();
  globalThis.WebSocket = originalWebSocket;
});
let directory: string;
let policyPath: string;
let credentials: InMemoryCredentialStore;
let runtime: ModelRuntime;
const sessions: AgentSession[] = [];

function profile(name: "personal" | "work") {
  writeFileSync(policyPath, readFileSync(join(profiles ?? "", `${name}.json`)));
}
function model(provider = "openai-codex", id = "gpt-6-astra"): Model<Api> {
  const selected = runtime.getModel(provider, id);
  if (!selected) throw new Error(`Missing test catalog model ${provider}/${id}`);
  return selected;
}
const user = (text = "Credential-free fixture") =>
  ({ role: "user", content: text, timestamp: Date.now() }) as const;
function assistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Fixture response" }],
    provider: "openai-codex",
    model: "gpt-6-astra",
    api: "openai-codex-responses",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 2000000,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2000001,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function history(marker: "personal" | "work" | "none" = "personal") {
  const manager = SessionManager.inMemory(directory);
  if (marker !== "none") manager.appendCustomEntry("dstack-model-policy", { profile: marker });
  manager.appendModelChange("openai-codex", "gpt-6-astra");
  manager.appendThinkingLevelChange("xhigh");
  manager.appendMessage(user("Old fixture ".repeat(500)));
  manager.appendMessage(assistant());
  manager.appendMessage(user("Latest fixture ".repeat(200)));
  manager.appendMessage(assistant());
  return manager;
}
async function session(manager = SessionManager.inMemory(directory), selected?: Model<Api>) {
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.6-sol",
    defaultThinkingLevel: "low",
    retry: { enabled: false },
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
  const created = await createAgentSession({
    cwd: directory,
    agentDir: join(directory, "agent"),
    modelRuntime: runtime,
    model: selected,
    settingsManager,
    resourceLoader,
    sessionManager: manager,
    tools: [],
  });
  sessions.push(created.session);
  return created.session;
}

beforeEach(async () => {
  configureInvocation([]);
  directory = mkdtempSync(join(tmpdir(), "pi-policy-runtime-"));
  process.env.HOME = directory;
  process.env.XDG_CONFIG_HOME = join(directory, "config");
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  for (const path of ["config/dstack", "agent"])
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
  policyPath = join(directory, "config/dstack/models.json");
  profile("personal");
  network.mockClear();
  socketCalls = 0;
  credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: token,
    refresh: "fixture",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "fixture",
  }));
  runtime = await ModelRuntime.create({
    credentials,
    modelsPath: join(directory, "agent/models.json"),
  });
  for (const provider of ["openai", "openrouter", "fireworks"])
    await runtime.setRuntimeApiKey(provider, "fixture");
});
afterEach(() => {
  configureInvocation([]);
  try {
    for (const current of sessions.splice(0)) current.dispose();
    expect(network).not.toHaveBeenCalled();
    expect(socketCalls).toBe(0);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["personal", "work"] as const)(
  "%s fresh parent ignores conflicting settings and inherits exact default",
  async (name) => {
    profile(name);
    runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: join(directory, "agent/models.json"),
    });
    const current = await session();
    expect(current.model?.provider).toBe(name === "work" ? "openai-codex" : "openrouter");
    expect(current.model?.id).toBe(
      name === "work" ? "gpt-6-astra" : "deepseek/deepseek-v4.1-flash",
    );
    expect(current.thinkingLevel).toBe(name === "work" ? "xhigh" : "max");
    current.setThinkingLevel("high");
    expect(current.thinkingLevel).toBe("high");
  },
);

test("explicit native selection is exact and missing auth never selects another provider", async () => {
  profile("work");
  runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const exact = resolveCliModel({
    cliModel: "openai-codex/gpt-5.6-sol:xhigh",
    modelRuntime: runtime,
  });
  expect(exact.error).toBeUndefined();
  expect(exact.model?.provider).toBe("openai-codex");
  expect(exact.model?.id).toBe("gpt-5.6-sol");
  const current = await session(undefined, exact.model);
  await expect(current.prompt("No auth")).rejects.toThrow();
  expect(current.model?.provider).toBe("openai-codex");
  expect(resolveCliModel({ cliModel: "sol", modelRuntime: runtime }).error).toContain(
    "provider/model",
  );
  expect(
    resolveCliModel({ cliProvider: "openai", cliModel: "gpt-5.6-sol", modelRuntime: runtime })
      .error,
  ).toBe("AI policy blocks unsupported provider openai.");
});

test("personal session switches to a Codex model the profile does not declare", async () => {
  const target = model("openai-codex", "gpt-5.6-sol");
  expect(
    resolveCliModel({ cliModel: "openai-codex/gpt-5.6-sol:xhigh", modelRuntime: runtime }).error,
  ).toBeUndefined();
  const current = await session();
  await current.setModel(target);
  expect(current.model?.provider).toBe("openai-codex");
  expect(current.model?.id).toBe("gpt-5.6-sol");
});

test.each([
  "stream",
  "streamSimple",
  "complete",
  "completeSimple",
  "streamDeferred",
  "fetchDeferred",
  "cancelDeferred",
] as const)("%s denies before provider invocation", async (method) => {
  const denied = model("openai", "gpt-5.6-sol");
  const provider = runtime.getProvider(denied.provider);
  if (!provider) throw new Error("Missing fixture provider");
  const stream = spyOn(provider, "stream");
  const simple = spyOn(provider, "streamSimple");
  const context = { messages: [user()] };
  const handle = { provider: denied.provider, modelId: denied.id, api: denied.api, id: "fixture" };
  if (method === "cancelDeferred")
    await expect(runtime.cancelDeferred(denied, handle)).rejects.toThrow("AI policy");
  else {
    const result =
      method === "stream"
        ? await runtime.stream(denied, context).result()
        : method === "streamSimple"
          ? await runtime.streamSimple(denied, context).result()
          : method === "complete"
            ? await runtime.complete(denied, context)
            : method === "completeSimple"
              ? await runtime.completeSimple(denied, context)
              : method === "streamDeferred"
                ? await runtime.streamDeferred(denied, handle).result()
                : await runtime.fetchDeferred(denied, handle);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("AI policy");
  }
  expect(stream).not.toHaveBeenCalled();
  expect(simple).not.toHaveBeenCalled();
  stream.mockRestore();
  simple.mockRestore();
});

test("normal turn and continuation stay guarded after direct model mutation and reload", async () => {
  const current = await session();
  await current.reload();
  current.agent.state.model = model("openai", "gpt-5.6-sol");
  await current.prompt("denied turn");
  const result = current.messages.at(-1);
  expect(result?.role === "assistant" && result.errorMessage).toContain("AI policy");
  current.agent.state.messages = [user("denied continuation")];
  await current.agent.continue();
  const continued = current.messages.at(-1);
  expect(continued?.role === "assistant" && continued.errorMessage).toContain("AI policy");
});

test("manual compaction, automatic compaction and branch summary use the guarded runtime", async () => {
  const manager = history();
  const current = await session(manager);
  current.agent.state.model = model("openai", "gpt-5.6-sol");
  await expect(current.compact()).rejects.toThrow("AI policy");
  const events: string[] = [];
  current.subscribe((event) => {
    if (event.type === "compaction_end" && event.reason === "threshold") events.push(event.type);
  });
  await current.prompt("auto compaction fixture");
  expect(events).toContain("compaction_end");
  const target = manager
    .getEntries()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  if (!target) throw new Error("Missing branch target");
  await expect(current.navigateTree(target.id, { summarize: true })).rejects.toThrow("AI policy");
});

test("selection and restore reject before mutation or cross-profile history transmission", async () => {
  const current = await session(history());
  const original = current.model;
  await expect(current.setModel(model("openai", "gpt-5.6-sol"))).rejects.toThrow("AI policy");
  expect(current.model).toBe(original);
  const available = spyOn(runtime, "getAvailableSnapshot").mockReturnValue([
    model(),
    model("openai", "gpt-5.6-sol"),
  ]);
  current.setScopedModels([{ model: model() }, { model: model("openai", "gpt-5.6-sol") }]);
  await expect(current.cycleModel()).rejects.toThrow("AI policy");
  current.setScopedModels([]);
  await expect(current.cycleModel()).rejects.toThrow("AI policy");
  expect(current.model).toBe(original);
  available.mockRestore();
  for (const marker of ["none", "work"] as const)
    await expect(session(history(marker))).rejects.toThrow("Start a new session");
  const manager = history();
  manager.appendModelChange("openai", "gpt-5.6-sol");
  await expect(session(manager)).rejects.toThrow("AI policy");
});

test("policy changes and malformed or missing files fail closed without recreating runtime", async () => {
  const selected = model();
  profile("work");
  expect((await runtime.completeSimple(selected, { messages: [user()] })).errorMessage).toContain(
    "profile changed",
  );
  writeFileSync(policyPath, "{");
  expect((await runtime.completeSimple(selected, { messages: [user()] })).errorMessage).toContain(
    "AI dispatch blocked",
  );
  rmSync(policyPath);
  expect((await runtime.completeSimple(selected, { messages: [user()] })).errorMessage).toContain(
    "AI dispatch blocked",
  );
  await expect(
    ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null }),
  ).rejects.toThrow("AI dispatch blocked");
});

test("API, base URL, post-auth endpoint and header substitutions never reach transport", async () => {
  const selected = model();
  for (const changed of [
    { ...selected, api: "anthropic-messages" },
    { ...selected, baseUrl: "https://evil.invalid" },
  ])
    expect((await runtime.completeSimple(changed, { messages: [user()] })).errorMessage).toContain(
      "substitution",
    );
  const auth = spyOn(runtime, "getAuth").mockImplementation(async () => ({
    auth: { apiKey: "fixture", baseUrl: "https://evil.invalid" },
    source: "fixture",
  }));
  expect((await runtime.completeSimple(selected, { messages: [user()] })).errorMessage).toContain(
    "substitution",
  );
  auth.mockImplementation(async () => ({ auth: { apiKey: "fixture" }, source: "fixture" }));
  expect(
    (
      await runtime.completeSimple(
        selected,
        { messages: [user()] },
        { transformHeaders: async () => ({ Host: "evil.invalid" }) },
      )
    ).errorMessage,
  ).toContain("header substitution");
  auth.mockRestore();
});

test("later provider registrations and recomposition cannot remove the core gate", async () => {
  const selected = model();
  runtime.registerProvider(selected.provider, {
    api: selected.api,
    streamSimple: () => {
      throw new Error("replacement called");
    },
  });
  expect((await runtime.completeSimple(selected, { messages: [user()] })).errorMessage).toContain(
    "replacement of native",
  );
  await runtime.refresh({ allowNetwork: false });
  expect((await runtime.completeSimple(selected, { messages: [user()] })).errorMessage).toContain(
    "replacement of native",
  );
  runtime.unregisterProvider(selected.provider);
  await runtime.refresh({ allowNetwork: false });
});

test.each([
  ["openai-codex", "gpt-6-astra"],
  ["openrouter", "z-ai/glm-5.3-flash"],
])("%s real serializer rejects transformed wire identities before HTTP", async (provider, id) => {
  profile("work");
  runtime = await ModelRuntime.create({ credentials, modelsPath: null });
  const selected = model(provider, id);
  for (const payload of [
    { model: "denied" },
    { model: id, models: ["denied"] },
    { model: id, fallbacks: [{ model: "denied" }] },
  ]) {
    const result = await runtime.completeSimple(
      selected,
      { messages: [user()] },
      { apiKey: provider === "openai-codex" ? token : "fixture", onPayload: () => payload },
    );
    expect(result.errorMessage).toContain("wire model substitution");
  }
});

test("allowed native request reaches its real transport with the exact wire model", async () => {
  profile("work");
  runtime = await ModelRuntime.create({ credentials, modelsPath: null });
  const observed: { wire: unknown; host: string | null } = { wire: undefined, host: null };
  const modelHeaders = { Host: "chatgpt.com" };
  const transformedHeaders = { Host: "chatgpt.com" };
  const transport = network.mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, init);
        const body = new Uint8Array(await request.arrayBuffer());
        observed.wire = JSON.parse(
          request.headers.get("content-encoding") === "zstd"
            ? zstdDecompressSync(body).toString()
            : new TextDecoder().decode(body),
        );
        observed.host = request.headers.get("host");
        throw new Error("Fixture transport reached; network disabled");
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const result = await runtime.completeSimple(
    { ...model(), headers: modelHeaders },
    { messages: [user()] },
    {
      apiKey: token,
      transport: "sse",
      maxRetries: 0,
      transformHeaders: async () => transformedHeaders,
      onPayload: () => {
        modelHeaders.Host = "evil.invalid";
        transformedHeaders.Host = "evil.invalid";
      },
    },
  );
  expect(transport).toHaveBeenCalledTimes(1);
  expect(observed.wire).toMatchObject({ model: "gpt-6-astra" });
  expect(observed.host).toBe("chatgpt.com");
  expect(result.stopReason).toBe("error");
  transport.mockClear();
});

test("Codex SSE and WebSocket payload substitutions are denied before transport", async () => {
  const auth = spyOn(runtime, "getAuth").mockImplementation(async () => ({
    auth: { apiKey: token },
    source: "fixture",
  }));
  for (const transport of ["sse", "websocket", "auto"] as const) {
    const result = await runtime.completeSimple(
      model(),
      { messages: [user()] },
      { transport, onPayload: () => ({ model: "denied" }) },
    );
    expect(result.errorMessage).toContain("wire model substitution");
  }
  auth.mockRestore();
});

test("automatic retry rechecks the profile before a second provider invocation", async () => {
  profile("work");
  runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  await runtime.setRuntimeApiKey("openrouter", "fixture");
  const current = await session(undefined, model("openrouter", "z-ai/glm-5.3-flash"));
  current.settingsManager.applyOverrides({
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
  });
  const events: string[] = [];
  current.subscribe((event) => {
    if (event.type === "auto_retry_start") events.push(event.type);
  });
  network.mockImplementation(
    Object.assign(
      async () => {
        profile("personal");
        return new Response(
          JSON.stringify({ error: { message: "rate_limit_error", type: "rate_limit_error" } }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  await current.prompt("one allowed fixture request, then denied retry");
  expect(events).toContain("auto_retry_start");
  expect(network).toHaveBeenCalledTimes(1);
  const final = current.messages.at(-1);
  expect(final?.role === "assistant" && final.errorMessage).toContain("AI policy");
  network.mockClear();
});

test("in-place SDK session switches cannot send history from another profile", async () => {
  const current = await session();
  const saved = SessionManager.create(directory, join(directory, "sessions"));
  saved.appendCustomEntry("dstack-model-policy", { profile: "work" });
  saved.appendModelChange("openai-codex", "gpt-6-astra");
  saved.appendMessage(user("Cross-profile fixture"));
  saved.appendMessage(assistant());
  const file = saved.getSessionFile();
  if (!file) throw new Error("Missing persisted fixture session");
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: join(directory, "agent"),
    modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  const host = new AgentSessionRuntime(current, services, async (options) => ({
    ...(await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      sessionStartEvent: options.sessionStartEvent,
      noTools: "all",
    })),
    services,
    diagnostics: [],
  }));
  await expect(host.switchSession(file)).rejects.toThrow("AI policy");
});

test("native provider registration and configured endpoints are checked before auth", async () => {
  const selected = model();
  const provider = runtime.getProvider(selected.provider);
  if (!provider) throw new Error("Missing fixture provider");
  runtime.registerNativeProvider(provider);
  expect((await runtime.completeSimple(selected, { messages: [user()] })).errorMessage).toContain(
    "replacement of native",
  );
  runtime.unregisterProvider(selected.provider);
  runtime.registerProvider(selected.provider, { baseUrl: "https://evil.invalid" });
  const auth = spyOn(runtime, "getAuth");
  expect((await runtime.completeSimple(selected, { messages: [user()] })).errorMessage).toContain(
    "endpoint substitution",
  );
  expect(auth).not.toHaveBeenCalled();
  auth.mockRestore();
});

test("cached Fireworks Anthropic transport reaches its real serializer with exact model and max effort", async () => {
  profile("work");
  const selected = cachedModels.fireworks[0];
  if (!selected) throw new Error("Missing cached Fireworks fixture");
  const modelsPath = join(directory, "agent/models.json");
  mkdirSync(join(directory, "agent"), { recursive: true });
  writeFileSync(
    join(directory, "agent/models-store.json"),
    JSON.stringify({
      fireworks: { models: [selected], checkedAt: Date.now(), lastModified: Date.now() },
    }),
  );
  runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath });
  const resolved = resolveCliModel({ cliModel: `fireworks/${selected.id}`, modelRuntime: runtime });
  expect(resolved.error).toBeUndefined();
  expect(resolved.model).toMatchObject(selected);
  if (!resolved.model) throw new Error("Missing resolved Fireworks model");
  const native = resolved.model;
  for (const changed of [
    { ...native, api: "openai-completions" },
    { ...native, baseUrl: "https://api.fireworks.ai/inference/v1" },
    { ...native, baseUrl: "https://api.fireworks.ai/inference/other" },
    { ...native, baseUrl: "https://api.fireworks.ai.evil.invalid/inference" },
    { ...native, baseUrl: "https://api.fireworks.ai/inference?route=other" },
  ])
    expect(
      (await runtime.completeSimple(changed, { messages: [user()] }, { apiKey: "fixture" }))
        .errorMessage,
    ).toContain("substitution");
  for (const payload of [
    { model: "denied" },
    { model: native.id, models: ["denied"] },
    { model: native.id, fallbacks: ["denied"] },
  ])
    expect(
      (
        await runtime.completeSimple(
          native,
          { messages: [user()] },
          { apiKey: "fixture", onPayload: () => payload },
        )
      ).errorMessage,
    ).toContain("wire model substitution");
  expect(
    (
      await runtime.completeSimple(
        native,
        { messages: [user()] },
        { apiKey: "fixture", headers: { Host: "evil.invalid" } },
      )
    ).errorMessage,
  ).toContain("header substitution");
  expect(network).not.toHaveBeenCalled();
  const observed: { wire: unknown; url: string } = { wire: undefined, url: "" };
  network.mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        observed.wire = JSON.parse(String(init?.body));
        observed.url = String(input);
        throw new Error("Fixture transport reached; network disabled");
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const result = await runtime.completeSimple(
    resolved.model,
    { messages: [user()] },
    { apiKey: "fixture", reasoning: "max", maxRetries: 0 },
  );
  expect(network).toHaveBeenCalledTimes(1);
  expect(observed.url).toBe("https://api.fireworks.ai/inference/v1/messages?beta=true");
  expect(observed.wire).toMatchObject({ model: selected.id, output_config: { effort: "max" } });
  expect(result.stopReason).toBe("error");
  network.mockClear();
});

test.each(["branch", "manual", "auto", "prompt"] as const)(
  "worker %s uses required effort through native serializer",
  async (kind) => {
    profile("work");
    configureInvocation([
      "--dstack-worker",
      JSON.stringify({
        profile: "work",
        selection: { kind: "role", role: "precise-code", member: "sol" },
        attempt: 0,
      }),
    ]);
    runtime = await ModelRuntime.create({ credentials, modelsPath: null });
    const manager = history("work");
    manager.appendModelChange("openai-codex", "gpt-5.6-sol");
    const current = await session(manager);
    const stream = current.agent.streamFunction;
    current.agent.streamFunction = (selected, context, options) =>
      stream(selected, context, { ...options, transport: "sse" });
    const wires: unknown[] = [];
    network.mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const request = new Request(input, init);
          const body = new Uint8Array(await request.arrayBuffer());
          wires.push(
            JSON.parse(
              request.headers.get("content-encoding") === "zstd"
                ? zstdDecompressSync(body).toString()
                : new TextDecoder().decode(body),
            ),
          );
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
          return new Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
        { preconnect: originalFetch.preconnect },
      ),
    );
    if (kind === "branch") {
      const target = manager
        .getEntries()
        .find((entry) => entry.type === "message" && entry.message.role === "user");
      if (!target) throw new Error("Missing branch fixture");
      expect((await current.navigateTree(target.id, { summarize: true })).cancelled).toBe(false);
    } else if (kind === "manual") {
      expect((await current.compact()).summary).toContain("Fixture summary");
    } else {
      if (kind === "prompt")
        current.settingsManager.applyOverrides({ compaction: { enabled: false } });
      await current.prompt("worker fixture");
      const last = current.messages.at(-1);
      expect(last?.role === "assistant" && last.stopReason).toBe("stop");
      if (kind === "auto")
        expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
    }
    expect(wires.length).toBeGreaterThan(0);
    for (const wire of wires)
      expect(wire).toMatchObject({ model: "gpt-5.6-sol", reasoning: { effort: "xhigh" } });
    network.mockClear();
  },
);
