import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { normalizeTabTitle, requestTabTitle } from "./tab-title.ts";

const codex: Model<"openai-codex-responses"> = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272000,
  maxTokens: 128000,
};
const openai: Model<"openai-responses"> = { ...codex, provider: "openai", api: "openai-responses" };

function response(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    content: [{ type: "text", text }],
    role: "assistant",
    provider: codex.provider,
    model: codex.id,
    api: codex.api,
    stopReason,
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

type Registry = Parameters<typeof requestTabTitle>[0];

function registry(complete: Registry["complete"]): Registry {
  return {
    find(provider, modelId) {
      assert.equal(modelId, "gpt-5.6-luna");
      return provider === "openai-codex" ? codex : openai;
    },
    complete,
  };
}

test("titles have at most four words and 28 Unicode code points", () => {
  assert.equal(normalizeTabTitle('  "Fix\nlogin\tredirect"  '), "Fix login redirect");
  assert.equal(normalizeTabTitle("one two three four five"), "one two three four");
  assert.equal(normalizeTabTitle("x".repeat(40)), "x".repeat(28));
  assert.equal(normalizeTabTitle("😀".repeat(40)), "😀".repeat(28));
  assert.equal(normalizeTabTitle("Fix\u202elogin\u0007redirect"), "Fix login redirect");
  assert.equal(normalizeTabTitle(" \n\t"), "");
});

test("Codex is first and success does not call OpenAI", async () => {
  const calls: string[] = [];
  const title = await requestTabTitle(
    registry(async (model, context, options) => {
      calls.push(model.provider);
      assert.equal(context.messages.length, 1);
      assert.equal(context.messages[0]?.content, "Fix login");
      assert.equal(context.tools, undefined);
      assert.equal(options?.transport, "sse");
      assert.equal(options?.cacheRetention, "none");
      assert.ok(options?.signal);
      return response("Fix login redirect");
    }),
    "Fix login",
    new AbortController().signal,
  );
  assert.equal(title, "Fix login redirect");
  assert.deepEqual(calls, ["openai-codex"]);
});

for (const failure of ["throw", "error", "empty", "aborted"]) {
  test(`OpenAI fallback handles Codex ${failure}`, async () => {
    const calls: string[] = [];
    const title = await requestTabTitle(
      registry(async (model) => {
        calls.push(model.provider);
        if (model.provider === "openai") return response("Fix login redirect");
        if (failure === "throw") throw new Error("Quota exhausted");
        if (failure === "empty") return response("");
        return response("", failure === "error" ? "error" : "aborted");
      }),
      "Fix login",
      new AbortController().signal,
    );
    assert.equal(title, "Fix login redirect");
    assert.deepEqual(calls, ["openai-codex", "openai"]);
  });
}

test("missing Codex model falls back to OpenAI", async () => {
  const title = await requestTabTitle(
    {
      find: (provider) => (provider === "openai" ? openai : undefined),
      complete: async (model) => {
        assert.equal(model.provider, "openai");
        return response("Fix login");
      },
    },
    "Fix login",
    new AbortController().signal,
  );
  assert.equal(title, "Fix login");
});

test("both provider failures are reported", async () => {
  await assert.rejects(
    requestTabTitle(
      registry(async () => {
        throw new Error("No credentials");
      }),
      "Fix login",
      new AbortController().signal,
    ),
    /openai-codex: No credentials; openai: No credentials/,
  );
});

test("session cancellation prevents fallback", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  await assert.rejects(
    requestTabTitle(
      registry(async (model) => {
        calls.push(model.provider);
        controller.abort(new Error("Session changed"));
        throw new Error("Cancelled");
      }),
      "Fix login",
      controller.signal,
    ),
    /Session changed/,
  );
  assert.deepEqual(calls, ["openai-codex"]);
});

test("late successful responses cannot rename an abandoned session", async () => {
  const controller = new AbortController();
  await assert.rejects(
    requestTabTitle(
      registry(async () => {
        controller.abort(new Error("Session changed"));
        return response("Stale title");
      }),
      "Fix login",
      controller.signal,
    ),
    /Session changed/,
  );
});

test("only a bounded first prompt reaches the title model", async () => {
  await requestTabTitle(
    registry(async (_model, context) => {
      assert.equal(context.messages[0]?.content, "a".repeat(8000));
      return response("Bounded prompt");
    }),
    "a".repeat(9000),
    new AbortController().signal,
  );
});
