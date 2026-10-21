import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { normalizeTabTitle, requestTabTitle } from "./tab-title.ts";

const openai: Model<"openai-responses"> = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272000,
  maxTokens: 128000,
};

function response(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    content: [{ type: "text", text }],
    role: "assistant",
    provider: openai.provider,
    model: openai.id,
    api: openai.api,
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
      assert.equal(provider, "openai");
      return openai;
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

test("title generation uses OpenAI without a Codex fallback", async () => {
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
  assert.deepEqual(calls, ["openai"]);
});

for (const failure of ["throw", "error", "empty", "aborted"]) {
  test(`OpenAI ${failure} is terminal without a Codex fallback`, async () => {
    const calls: string[] = [];
    await assert.rejects(
      requestTabTitle(
        registry(async (model) => {
          calls.push(model.provider);
          if (failure === "throw") throw new Error("Quota exhausted");
          if (failure === "empty") return response("");
          return response("", failure === "error" ? "error" : "aborted");
        }),
        "Fix login",
        new AbortController().signal,
      ),
      failure === "throw"
        ? /Quota exhausted/
        : failure === "empty"
          ? /empty title/
          : /Title generation failed/,
    );
    assert.deepEqual(calls, ["openai"]);
  });
}

test("missing OpenAI model fails without a Codex fallback", async () => {
  await assert.rejects(
    requestTabTitle(
      {
        find(provider) {
          assert.equal(provider, "openai");
          return undefined;
        },
        complete: async () => assert.fail("Missing OpenAI model must not complete"),
      },
      "Fix login",
      new AbortController().signal,
    ),
    /Model unavailable/,
  );
});

test("OpenAI credential failures are reported", async () => {
  await assert.rejects(
    requestTabTitle(
      registry(async () => {
        throw new Error("No credentials");
      }),
      "Fix login",
      new AbortController().signal,
    ),
    /No credentials/,
  );
});

test("session cancellation stops title generation", async () => {
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
  assert.deepEqual(calls, ["openai"]);
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
