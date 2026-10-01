import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupSessionResources,
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import cachedModels from "./cached-models";

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
  for (const provider of ["openrouter", "fireworks", "openai-codex"])
    await runtime.setRuntimeApiKey(provider, provider === "openai-codex" ? token : "fixture");
}
function model(provider: string, id: string): Model<Api> {
  const selected =
    [...cachedModels.fireworks, ...cachedModels.openrouter].find(
      (candidate) => candidate.provider === provider && candidate.id === id,
    ) ?? runtime.getModel(provider, id);
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
  policy.routes.sol[0].model = "openai-codex/gpt-6-astra";
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
  cleanupSessionResources();
  globalThis.WebSocket = originalWebSocket;
  network.mockReset();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(directory, { recursive: true, force: true });
});

const httpModels = [
  ["openai-codex", "gpt-5.6-sol"],
  ["openrouter", "z-ai/glm-5.3-flash"],
  ["fireworks", "accounts/fireworks/models/deepseek-v4p1-flash"],
] as const;
for (const [provider, id] of httpModels) {
  test.each(["profile", "corrupt", "unchanged"] as const)(
    `${provider} native HTTP retry %s`,
    async (change) => {
      let payloadCalls = 0;
      respond = () => {
        if (calls.length > 1) return badRequest();
        if (change === "profile") profile("personal");
        if (change === "corrupt") corrupt();
        return rateLimit();
      };
      const result = await runtime.completeSimple(
        model(provider, id),
        { messages: [...context.messages] },
        {
          apiKey: provider === "openai-codex" ? token : "fixture",
          reasoning: provider === "fireworks" ? "max" : "xhigh",
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

test("parent compatible effort overrides remain available at the wire", async () => {
  let wire: unknown;
  await runtime.completeSimple(
    model("openai-codex", "gpt-5.6-sol"),
    { messages: [...context.messages] },
    {
      reasoning: "high",
      transport: "sse",
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

