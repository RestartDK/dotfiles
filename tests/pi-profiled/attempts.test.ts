import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  cleanupSessionResources,
  InMemoryCredentialStore,
  type Api,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import cachedModels from "./cached-models";

const { configureInvocation } = await import("../../dist/core/dstack-policy.js");
const profiles = process.env.PI_POLICY_TEST_PROFILES;
if (!profiles) throw new Error("Missing profile fixtures");
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture`;
const context = { messages: [{ role: "user", content: "fixture", timestamp: 0 }] } as const;
let directory: string;
let policyPath: string;
let runtime: ModelRuntime;
let calls: string[];
let connects: number;
let sends: string[];
let respond: () => Response;
let socketEvent: (socket: EventTarget, attempt: number) => void;
let connected: () => void;
const network = spyOn(globalThis, "fetch");
afterAll(() => network.mockRestore());
function profile(name: "work" | "personal") {
  writeFileSync(policyPath, readFileSync(join(profiles ?? "", `${name}.json`)));
}
async function createRuntime() {
  runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  spyOn(runtime, "getAuth").mockImplementation(async () => ({
    auth: { apiKey: token },
    source: "fixture",
  }));
  for (const provider of ["openai", "anthropic", "openrouter", "fireworks", "openai-codex"])
    await runtime.setRuntimeApiKey(provider, provider === "openai-codex" ? token : "fixture");
}
function model(provider: string, id: string): Model<Api> {
  const selected = runtime.getModel(provider, id);
  if (!selected) throw new Error(`Missing fixture model ${provider}/${id}`);
  return selected;
}
function rateLimit() {
  return new Response(
    JSON.stringify({ error: { message: "rate_limit_error", type: "rate_limit_error" } }),
    {
      status: 429,
      headers: { "content-type": "application/json", "retry-after-ms": "1" },
    },
  );
}
function badRequest() {
  return new Response(
    JSON.stringify({ error: { message: "fixture stop", type: "invalid_request_error" } }),
    {
      status: 400,
      headers: { "content-type": "application/json" },
    },
  );
}
function corrupt() {
  writeFileSync(policyPath, "{");
}
function revoke() {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  policy.routes.sol[0].model = "openai/gpt-6-astra";
  writeFileSync(policyPath, JSON.stringify(policy));
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "pi-attempt-policy-"));
  process.env.HOME = directory;
  process.env.XDG_CONFIG_HOME = join(directory, "config");
  process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  mkdirSync(join(directory, "config/dstack"), { recursive: true });
  policyPath = join(directory, "config/dstack/models.json");
  profile("work");
  configureInvocation([]);
  calls = [];
  connects = 0;
  sends = [];
  respond = badRequest;
  connected = () => {};
  socketEvent = (socket) =>
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "error", code: "fixture_stop", message: "fixture stop" }),
      }),
    );
  network.mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input));
        return respond();
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  globalThis.WebSocket = new Proxy(originalWebSocket, {
    construct() {
      connects++;
      const socket = Object.assign(new EventTarget(), {
        readyState: 1,
        close() {
          this.readyState = 3;
        },
        send(body: string) {
          sends.push(body);
          setTimeout(() => socketEvent(socket, sends.length), 0);
        },
      });
      queueMicrotask(() => {
        connected();
        socket.dispatchEvent(new Event("open"));
      });
      return socket;
    },
  });
  await createRuntime();
});
afterEach(() => {
  configureInvocation([]);
  cleanupSessionResources();
  globalThis.WebSocket = originalWebSocket;
  network.mockReset();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(directory, { recursive: true, force: true });
});

const httpModels = [
  ["openai", "gpt-5.6-sol"],
  ["openrouter", "z-ai/glm-5.3-flash"],
  ["anthropic", "claude-fable-5-1"],
  ["openai-codex", "gpt-6-astra"],
] as const;
for (const [provider, id] of httpModels) {
  test.each(["profile", "corrupt", "unchanged"] as const)(
    `${provider} native HTTP retry %s`,
    async (change) => {
      if (provider === "openai-codex") {
        profile("personal");
        await createRuntime();
      }
      let payloadCalls = 0;
      respond = () => {
        if (calls.length > 1) return badRequest();
        if (change === "profile") profile(provider === "openai-codex" ? "work" : "personal");
        if (change === "corrupt") corrupt();
        return rateLimit();
      };
      const result = await runtime.completeSimple(
        model(provider, id),
        { messages: [...context.messages] },
        {
          apiKey: provider === "openai-codex" ? token : "fixture",
          reasoning: "xhigh",
          transport: "sse",
          maxRetries: 1,
          onPayload: () => {
            payloadCalls++;
          },
        },
      );
      if (calls.length === 0) throw new Error(result.errorMessage);
      expect(calls.length).toBe(change === "unchanged" ? 2 : 1);
      expect(payloadCalls).toBe(1);
      expect(result.errorMessage).toContain(change === "unchanged" ? "fixture stop" : "AI ");
    },
  );
}

test("native HTTP retry rechecks revoked route", async () => {
  respond = () => {
    revoke();
    return rateLimit();
  };
  const result = await runtime.completeSimple(
    model("openai", "gpt-5.6-sol"),
    { messages: [...context.messages] },
    { maxRetries: 1 },
  );
  expect(calls.length).toBe(1);
  expect(result.errorMessage).toContain("AI ");
});

for (const failure of [
  "websocket_connection_limit_reached",
  "previous_response_not_found",
  "transport",
] as const) {
  test.each(["corrupt", "unchanged"] as const)(`Codex ${failure} %s`, async (change) => {
    profile("personal");
    await createRuntime();
    socketEvent = (socket, attempt) => {
      if (attempt === 1) {
        if (change === "corrupt") corrupt();
        if (failure === "transport") socket.dispatchEvent(new Event("error"));
        else
          socket.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify({ type: "error", code: failure }) }),
          );
      } else
        socket.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ type: "error", code: "fixture_stop", message: "fixture stop" }),
          }),
        );
    };
    const result = await runtime.completeSimple(
      model("openai-codex", "gpt-6-astra"),
      { messages: [...context.messages] },
      { transport: "auto", env: {}, maxRetries: 0 },
    );
    expect(connects).toBe(change === "unchanged" && failure !== "transport" ? 2 : 1);
    expect(sends.length).toBe(change === "unchanged" && failure !== "transport" ? 2 : 1);
    expect(calls.length).toBe(change === "unchanged" && failure === "transport" ? 1 : 0);
    expect(result.errorMessage).toContain(change === "unchanged" ? "fixture stop" : "AI ");
  });
}
test("Codex revocation during handshake denies send and fallback", async () => {
  profile("personal");
  await createRuntime();
  connected = corrupt;
  const result = await runtime.completeSimple(
    model("openai-codex", "gpt-6-astra"),
    { messages: [...context.messages] },
    { transport: "websocket", env: {} },
  );
  expect(connects).toBe(1);
  expect(sends.length).toBe(0);
  expect(calls.length).toBe(0);
  expect(result.errorMessage).toContain("AI ");
});

function worker(
  role = "precise-code",
  member = "sol",
  attempt = 0,
  name: "work" | "personal" = "work",
) {
  configureInvocation([
    "--dstack-worker",
    JSON.stringify({ profile: name, selection: { kind: "role", role, member }, attempt }),
  ]);
}
test("worker rejects stale effort after policy reload before transport", async () => {
  worker();
  await createRuntime();
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  policy.routes.sol[0].thinking = "medium";
  writeFileSync(policyPath, JSON.stringify(policy));
  const result = await runtime.completeSimple(
    model("openai", "gpt-5.6-sol"),
    { messages: [...context.messages] },
    { reasoning: "xhigh" },
  );
  expect(calls.length).toBe(0);
  expect(result.errorMessage).toContain("Restart");
});

test.each(["medium", "max"] as const)(
  "worker rejects %s request effort before serializer",
  async (reasoning) => {
    worker();
    await createRuntime();
    const result = await runtime.completeSimple(
      model("openai", "gpt-5.6-sol"),
      { messages: [...context.messages] },
      { reasoning },
    );
    expect(calls.length).toBe(0);
    expect(result.errorMessage).toContain("AI policy");
  },
);

const workerModels = [
  {
    profile: "work",
    role: "precise-code",
    member: "sol",
    attempt: 0,
    provider: "openai",
    id: "gpt-5.6-sol",
    effort: "xhigh",
  },
  {
    profile: "work",
    role: "review",
    member: "fable",
    attempt: 1,
    provider: "anthropic",
    id: "claude-fable-5-1",
    effort: "xhigh",
  },
  {
    profile: "work",
    role: "how-explorer",
    member: "deepseek",
    attempt: 0,
    provider: "fireworks",
    id: "accounts/fireworks/models/deepseek-v4p1-flash",
    effort: "max",
  },
  {
    profile: "work",
    role: "fast-code",
    member: "glm",
    attempt: 0,
    provider: "openrouter",
    id: "z-ai/glm-5.3-flash",
    effort: "max",
  },
  {
    profile: "work",
    role: "feature",
    member: "astra",
    attempt: 0,
    provider: "openai",
    id: "gpt-6-astra",
    effort: "xhigh",
  },
  {
    profile: "work",
    role: "architect-runners",
    member: "opus",
    attempt: 0,
    provider: "anthropic",
    id: "claude-opus-5",
    effort: "xhigh",
  },
  {
    profile: "personal",
    role: "how-explorer",
    member: "deepseek",
    attempt: 0,
    provider: "openrouter",
    id: "deepseek/deepseek-v4.1-flash",
    effort: "max",
  },
  {
    profile: "personal",
    role: "precise-code",
    member: "astra",
    attempt: 0,
    provider: "openai-codex",
    id: "gpt-6-astra",
    effort: "xhigh",
  },
] satisfies {
  profile: "work" | "personal";
  role: string;
  member: string;
  attempt: number;
  provider: string;
  id: string;
  effort: "xhigh" | "max";
}[];
for (const target of workerModels) {
  test(`${target.provider}/${target.id} worker defaults use native normalized effort and block wire transforms`, async () => {
    profile(target.profile);
    worker(target.role, target.member, target.attempt, target.profile);
    await createRuntime();
    const selected =
      [...cachedModels.fireworks, ...cachedModels.openrouter].find(
        (candidate) => candidate.provider === target.provider && candidate.id === target.id,
      ) ?? model(target.provider, target.id);
    let wire: unknown;
    network.mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          calls.push("request");
          const request = new Request(input, init);
          const body = new Uint8Array(await request.arrayBuffer());
          wire = JSON.parse(
            request.headers.get("content-encoding") === "zstd"
              ? zstdDecompressSync(body).toString()
              : new TextDecoder().decode(body),
          );
          return badRequest();
        },
        { preconnect: originalFetch.preconnect },
      ),
    );
    const baseline = await runtime.completeSimple(
      selected,
      { messages: [...context.messages] },
      { maxRetries: 0, transport: "sse" },
    );
    if (calls.length === 0) throw new Error(baseline.errorMessage);
    expect(calls.length).toBe(1);
    expect(baseline.errorMessage).toContain("fixture stop");
    expect(wire).toMatchObject(
      selected.api === "anthropic-messages"
        ? {
            thinking: { type: "adaptive" },
            output_config: { effort: target.provider === "anthropic" ? "high" : target.effort },
          }
        : { reasoning: { effort: target.effort } },
    );
    if (target.provider === "anthropic") {
      expect(wire).toHaveProperty("messages");
      if (
        typeof wire !== "object" ||
        wire === null ||
        !("messages" in wire) ||
        !Array.isArray(wire.messages)
      )
        throw new Error("Missing native messages");
      expect(wire.messages.at(-1)).toEqual({
        role: "system",
        content: [],
        output_config: { effort: target.effort },
      });
    }
    calls = [];
    for (const changed of [undefined, "none", "low", "max" === target.effort ? "xhigh" : "max"]) {
      const result = await runtime.completeSimple(
        selected,
        { messages: [...context.messages] },
        {
          onPayload: (payload) => {
            if (typeof payload !== "object" || payload === null)
              throw new Error("Missing serialized payload");
            return {
              ...payload,
              reasoning: changed ? { effort: changed } : undefined,
              output_config: changed ? { effort: changed } : undefined,
              thinking: { type: "disabled" },
            };
          },
        },
      );
      expect(result.errorMessage).toContain("AI policy");
    }
    expect(calls.length).toBe(0);
  });

  const transports: SimpleStreamOptions["transport"][] =
    target.provider === "openai-codex" ? ["sse", "websocket", "auto"] : ["sse"];
  for (const transport of transports) {
    test.each(["low", "none", "off", "unrelated"])(
      `${target.provider}/${target.id} ${transport} worker rejects native effort mapping %s`,
      async (mapping) => {
        profile(target.profile);
        worker(target.role, target.member, target.attempt, target.profile);
        await createRuntime();
        const selected =
          [...cachedModels.fireworks, ...cachedModels.openrouter].find(
            (candidate) => candidate.provider === target.provider && candidate.id === target.id,
          ) ?? model(target.provider, target.id);
        const changed: Model<Api> = {
          ...selected,
          thinkingLevelMap: { ...selected.thinkingLevelMap, [target.effort]: mapping },
        };
        const result = await runtime.completeSimple(
          changed,
          { messages: [...context.messages] },
          { transport, env: {}, maxRetries: 0 },
        );
        expect(calls).toEqual([]);
        expect(connects).toBe(0);
        expect(sends).toEqual([]);
        expect(result.errorMessage).toContain("AI policy");
      },
    );
  }
}

test.each(["low", "none", "off", "unrelated"])(
  "GLM worker rejects a forged xhigh mapping %s instead of normalizing upward",
  async (mapping) => {
    worker("fast-code", "glm");
    await createRuntime();
    const selected = cachedModels.openrouter.find(
      (candidate) => candidate.id === "z-ai/glm-5.3-flash",
    );
    if (!selected) throw new Error("Missing GLM fixture");
    const result = await runtime.completeSimple(
      { ...selected, thinkingLevelMap: { ...selected.thinkingLevelMap, xhigh: mapping } },
      { messages: [...context.messages] },
      { maxRetries: 0 },
    );
    expect(calls).toEqual([]);
    expect(connects).toBe(0);
    expect(sends).toEqual([]);
    expect(result.errorMessage).toContain("AI policy");
  },
);

test("worker raw requests cannot bypass wire effort and valid raw effort still works", async () => {
  worker();
  await createRuntime();
  const selected = model("openai", "gpt-5.6-sol");
  for (const reasoningEffort of [undefined, "none", "low", "max"] as const) {
    const result = await runtime.complete(
      selected,
      { messages: [...context.messages] },
      { reasoningEffort },
    );
    expect(result.errorMessage).toContain("AI policy");
  }
  expect(calls.length).toBe(0);
  const allowed = await runtime.complete(
    selected,
    { messages: [...context.messages] },
    { reasoningEffort: "xhigh" },
  );
  expect(calls.length).toBe(1);
  expect(allowed.errorMessage).toContain("fixture stop");
});

test("worker request hook cannot be overridden and sampling parameters cannot lower effort", async () => {
  worker();
  await createRuntime();
  const result = await runtime.completeSimple(
    model("openai", "gpt-5.6-sol"),
    { messages: [...context.messages] },
    {
      reasoning: "xhigh",
      samplingParams: { reasoning: { effort: "low" } },
      beforeRequest: () => undefined,
    },
  );
  expect(result.errorMessage).toContain("AI policy");
  expect(calls.length).toBe(0);
});

test("worker effort changes during retry stop the next native attempt", async () => {
  worker();
  await createRuntime();
  respond = () => {
    const policy = JSON.parse(readFileSync(policyPath, "utf8"));
    policy.routes.sol[0].thinking = "medium";
    writeFileSync(policyPath, JSON.stringify(policy));
    return rateLimit();
  };
  const result = await runtime.completeSimple(
    model("openai", "gpt-5.6-sol"),
    { messages: [...context.messages] },
    {
      reasoning: "xhigh",
      maxRetries: 1,
      beforeRequest: () => undefined,
    },
  );
  expect(calls.length).toBe(1);
  expect(result.errorMessage).toContain("Restart");
});

test("managed Anthropic worker validates the final effort control message", async () => {
  worker("review", "fable", 1);
  await createRuntime();
  for (const effort of [undefined, "low", "max"] as const) {
    const result = await runtime.completeSimple(
      model("anthropic", "claude-fable-5-1"),
      { messages: [...context.messages] },
      {
        onPayload: (payload) => {
          if (
            typeof payload !== "object" ||
            payload === null ||
            !("messages" in payload) ||
            !Array.isArray(payload.messages)
          )
            throw new Error("Missing native messages");
          return {
            ...payload,
            messages: [
              ...payload.messages.slice(0, -1),
              ...(effort ? [{ role: "system", content: [], output_config: { effort } }] : []),
            ],
          };
        },
      },
    );
    expect(result.errorMessage).toContain("AI policy");
  }
  expect(calls.length).toBe(0);
});

test("parent compatible effort overrides remain available at the wire", async () => {
  let wire: unknown;
  await runtime.completeSimple(
    model("openai", "gpt-5.6-sol"),
    { messages: [...context.messages] },
    {
      reasoning: "high",
      onPayload: (payload) => {
        wire = payload;
      },
    },
  );
  expect(calls.length).toBe(1);
  expect(wire).toMatchObject({ reasoning: { effort: "high" } });
});

test.each(httpModels)(
  "%s declared transport has no deferred dispatch escape",
  async (provider, id) => {
    if (provider === "openai-codex") {
      profile("personal");
      await createRuntime();
    }
    const selected = model(provider, id);
    const handle = { provider, modelId: id, api: selected.api, id: "fixture" };
    expect((await runtime.fetchDeferred(selected, handle)).errorMessage).toContain(
      "does not support deferred",
    );
    await expect(runtime.cancelDeferred(selected, handle)).rejects.toThrow(
      "does not support deferred",
    );
    expect(calls.length).toBe(0);
    expect(connects).toBe(0);
  },
);

test("personal Codex worker enforces normalized effort on HTTP and WebSocket", async () => {
  profile("personal");
  configureInvocation([
    "--dstack-worker",
    JSON.stringify({
      profile: "personal",
      selection: { kind: "role", role: "precise-code", member: "astra" },
      attempt: 0,
    }),
  ]);
  await createRuntime();
  const selected = model("openai-codex", "gpt-6-astra");
  let payload: unknown;
  await runtime.completeSimple(
    selected,
    { messages: [...context.messages] },
    {
      transport: "sse",
      onPayload: (wire) => {
        payload = wire;
      },
    },
  );
  expect(calls.length).toBe(1);
  expect(payload).toMatchObject({ reasoning: { effort: "xhigh" } });
  await runtime.completeSimple(
    selected,
    { messages: [...context.messages] },
    { transport: "websocket", env: {} },
  );
  expect(sends.length).toBe(1);
  expect(JSON.parse(sends[0] ?? "null")).toMatchObject({ reasoning: { effort: "xhigh" } });
  for (const transport of ["sse", "websocket"] as const) {
    const result = await runtime.completeSimple(
      selected,
      { messages: [...context.messages] },
      {
        transport,
        env: {},
        onPayload: () => ({ model: selected.id, reasoning: { effort: "low" } }),
      },
    );
    expect(result.errorMessage).toContain("AI policy");
  }
  expect(calls.length).toBe(1);
  expect(sends.length).toBe(1);
});

test("Fireworks alternate native Completions pair enforces max effort", async () => {
  worker("how-explorer", "deepseek");
  await createRuntime();
  const cached = cachedModels.fireworks[0];
  if (!cached) throw new Error("Missing Fireworks fixture");
  const selected: Model<"openai-completions"> = {
    ...cached,
    api: "openai-completions",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    compat: { supportsReasoningEffort: true },
  };
  let wire: unknown;
  await runtime.completeSimple(
    selected,
    { messages: [...context.messages] },
    {
      onPayload: (payload) => {
        wire = payload;
      },
    },
  );
  expect(calls.length).toBe(1);
  expect(wire).toMatchObject({ reasoning_effort: "max" });
  const result = await runtime.complete(
    selected,
    { messages: [...context.messages] },
    { reasoningEffort: "low" },
  );
  expect(result.errorMessage).toContain("AI policy");
  expect(calls.length).toBe(1);
  calls = [];
  for (const mapping of ["low", "none", "off", "unrelated"]) {
    const denied = await runtime.completeSimple(
      { ...selected, thinkingLevelMap: { ...selected.thinkingLevelMap, max: mapping } },
      { messages: [...context.messages] },
      { maxRetries: 0 },
    );
    expect(calls).toEqual([]);
    expect(connects).toBe(0);
    expect(sends).toEqual([]);
    expect(denied.errorMessage).toContain("AI policy");
  }
});
