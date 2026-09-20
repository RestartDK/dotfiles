import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Protocol, type Failure } from "../../config/pi/agent/extensions/subagents/protocol";

import { piAssistantMessage, piToolActivityEvents, piWriteEnd } from "./pi-tool-events";

const events: unknown[] = readFileSync(join(import.meta.dir, "claude-quota.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

test("real synthetic quota retains init identity and recognizes error despite success subtype", () => {
  const protocol = new Protocol(
    { kind: "claude-cli", model: "claude-fable-5-1", thinking: "xhigh" },
    [],
  );
  for (const event of events) protocol.accept(event);
  expect(protocol.actualModel).toBe("claude-fable-5-1");
  expect(protocol.toolUsed).toBe(false);
  expect(protocol.terminal).toEqual({ kind: "failure", reason: "rate_limit", provider: "quota" });
});

function piError(errorMessage: string) {
  const protocol = new Protocol(
    { kind: "pi", provider: "anthropic", id: "claude-fable-5-1", thinking: "xhigh" },
    [],
  );
  protocol.accept({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-fable-5-1",
      content: [],
      stopReason: "error",
      errorMessage,
    },
  });
  return protocol.terminal;
}

test.each([
  {
    message: '401 {"type":"error","error":{"type":"authentication_error","message":"TEST_AUTH"}}',
    failure: "auth",
  },
  {
    message: '403 {"type":"error","error":{"type":"permission_error","message":"TEST_AUTH"}}',
    failure: "auth",
  },
  {
    message: '500 {"type":"error","error":{"type":"api_error","message":"TEST_UNAVAILABLE"}}',
    failure: "unavailable",
  },
  {
    message:
      '529 {"type":"error","error":{"type":"overloaded_error","message":"TEST_UNAVAILABLE"}}',
    failure: "unavailable",
  },
  {
    message:
      'OpenAI API error (401): {"type":"invalid_request_error","code":"invalid_api_key","message":"TEST_AUTH"}',
    failure: "auth",
  },
  {
    message:
      'OpenAI API error (429): {"type":"rate_limit_exceeded","code":"rate_limit_exceeded","message":"TEST_QUOTA"}',
    failure: "quota",
  },
  {
    message:
      'OpenAI API error (500): {"type":"server_error","code":null,"message":"TEST_UNAVAILABLE"}',
    failure: "unavailable",
  },
  {
    message:
      'OpenAI API error (503): {"type":"server_error","code":null,"message":"TEST_UNAVAILABLE"}',
    failure: "unavailable",
  },
  {
    message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"TEST_QUOTA"}}',
    failure: "quota",
  },
  {
    message:
      'OpenAI API error (429): {"type":"insufficient_quota","code":"insufficient_quota","message":"TEST_QUOTA"}',
    failure: "quota",
  },
])("native HTTP envelope $message classifies as $failure", ({ message, failure }) => {
  expect(piError(message)).toEqual({ kind: "failure", reason: message, provider: failure });
});

test.each([
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"broken"}',
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"quota"}} trailing',
  '429 {"type":"error","error":{"type":"unknown_error","message":"quota"}}',
  '401 {"type":"error","error":{"type":"rate_limit_error","message":"quota"}}',
  '429 {"type":"error","error":{"type":"authentication_error","message":"auth"}}',
  '403 {"type":"error","error":{"type":"authentication_error","message":"auth"}}',
  '400 {"type":"error","error":{"type":"rate_limit_error","message":"quota"}}',
  '200 {"type":"error","error":{"type":"rate_limit_error","message":"quota"}}',
  '429 {"type":"error","error":{"type":"rate_limit","message":"synthetic"}}',
  '429 {"type":"error","error":{"type":"rate_limit_error"}}',
  '429 {"type":"error","error":{"type":"rate_limit_error","message":42}}',
  '429 {"type":"message","error":{"type":"rate_limit_error","message":"quota"}}',
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"quota","status":401}}',
  '429 {"type":"error","status":401,"error":{"type":"rate_limit_error","message":"quota"}}',
  'OpenAI API error (429): {"type":"insufficient_quota","message":"broken"',
  'OpenAI API error (429): {"type":"unknown","message":"quota"}',
  'OpenAI API error (401): {"type":"insufficient_quota","message":"quota"}',
  'OpenAI API error (429): {"type":"server_error","message":"unavailable"}',
  '529 {"type":"error","error":{"type":"api_error","message":"unavailable"}}',
  '503 {"type":"error","error":{"type":"overloaded_error","message":"unavailable"}}',
  'OpenAI API error (401): {"type":"invalid_api_key","message":"auth"}',
  '401 {"type":"error","error":{"type":"invalid_request_error","code":"invalid_api_key","message":"auth"}}',
  'OpenAI API error (400): {"type":"invalid_request_error","code":"invalid_api_key","message":"auth"}',
  'OpenAI API error (401): {"type":"invalid_request_error","code":"unknown","message":"auth"}',
  'OpenAI API error (401): {"type":"invalid_request_error","message":"auth"}',
  'OpenAI API error (429): {"type":"insufficient_quota","code":"invalid_api_key","message":"quota"}',
  'OpenAI API error (429): {"type":"insufficient_quota","message":"quota","status":401}',
  'OpenAI API error (429): {"error":{"type":"insufficient_quota","message":"quota"}}',
  'OpenAI API error (429): ["insufficient_quota"]',
  "OpenAI API error (429): null",
  'OpenAI API error (429): {"type":"insufficient_quota","message":"quota"} trailing',
  'tests failed: 429 {"type":"error","error":{"type":"rate_limit_error","message":"quota"}}',
  'tests failed: OpenAI API error (429): {"type":"insufficient_quota","message":"quota"}',
  "rate_limit_error",
  "insufficient_quota",
])("native HTTP rejects malformed, unknown or contradictory input %s", (message) => {
  expect(piError(message)).toMatchObject({ kind: "failure", provider: undefined });
});

test("Pi provider classification is bounded to 4096 bytes", () => {
  const prefix = '429 {"type":"error","error":{"type":"rate_limit_error","message":"';
  const suffix = '"}}';
  const exact = prefix + "x".repeat(4096 - prefix.length - suffix.length) + suffix;
  expect(Buffer.byteLength(exact)).toBe(4096);
  expect(piError(exact)).toMatchObject({ provider: "quota" });
  expect(piError(exact.replace('"message":"', '"message":"x'))).toMatchObject({
    provider: undefined,
  });
  const multibyte = prefix + "å".repeat(2100) + suffix;
  expect(multibyte.length).toBeLessThan(4096);
  expect(Buffer.byteLength(multibyte)).toBeGreaterThan(4096);
  expect(piError(multibyte)).toMatchObject({ provider: undefined });
});

test.each([
  ['{"status":429}', "quota"],
  ['{"error":{"status":401}}', "auth"],
  ['{"error":{"type":"overloaded"}}', "unavailable"],
  ["401 Unauthorized", "auth"],
  ["No API key found for anthropic.", "auth"],
  ["429 Too Many Requests", "quota"],
  ["429 rate_limit_error", "quota"],
  ["503 Service Unavailable", "unavailable"],
  ["rate_limit", "quota"],
] satisfies [string, Failure][])(
  "existing Pi error format %s remains accepted",
  (message, failure) => {
    expect(piError(message)).toEqual({ kind: "failure", reason: message, provider: failure });
  },
);

test.each(["rate_limit_error", "insufficient_quota", "authentication_error", "api_error"])(
  "native error type %s does not broaden Claude synthetic vocabulary",
  (error) => {
    const protocol = new Protocol(
      { kind: "claude-cli", model: "claude-fable-5-1", thinking: "xhigh" },
      [],
    );
    protocol.accept(events[0]);
    expect(() =>
      protocol.accept({
        type: "assistant",
        error,
        is_api_error_message: true,
        message: {
          model: "<synthetic>",
          role: "assistant",
          type: "message",
          stop_reason: "stop_sequence",
          stop_sequence: "",
          content: [{ type: "text", text: "Native error" }],
        },
      }),
    ).toThrow("Malformed Claude synthetic provider error");
  },
);

test.each(piToolActivityEvents)("Pi $name latches without preceding tool frames", ({ event }) => {
  const protocol = new Protocol(
    { kind: "pi", provider: "anthropic", id: "claude-fable-5-1", thinking: "xhigh" },
    ["write"],
  );
  protocol.accept(event);
  expect(protocol.toolUsed).toBe(true);
  protocol.accept({
    type: "message_end",
    message: { ...piAssistantMessage, stopReason: "error", errorMessage: "429 Too Many Requests" },
  });
  expect(protocol.toolUsed).toBe(true);
  expect(protocol.terminal).toEqual({
    kind: "failure",
    reason: "429 Too Many Requests",
    provider: "quota",
  });
});

for (const stopReason of ["stop", "error"]) {
  test.each(piToolActivityEvents)(
    `Pi $name preserves prior ${stopReason} terminal except at execution start`,
    ({ event }) => {
      const protocol = new Protocol(
        { kind: "pi", provider: "anthropic", id: "claude-fable-5-1", thinking: "xhigh" },
        ["write"],
      );
      protocol.accept({
        type: "message_end",
        message: { ...piAssistantMessage, stopReason, errorMessage: "429 Too Many Requests" },
      });
      const terminal = protocol.terminal;
      expect(terminal).toBeDefined();
      protocol.accept(event);
      expect(protocol.terminal).toEqual(
        event.type === "tool_execution_start" ? undefined : terminal,
      );
    },
  );
}

test("Pi end-only write result followed by a new assistant still finishes successfully", () => {
  const protocol = new Protocol(
    { kind: "pi", provider: "anthropic", id: "claude-fable-5-1", thinking: "xhigh" },
    ["write"],
  );
  protocol.accept(piWriteEnd);
  protocol.accept({ type: "message_end", message: piAssistantMessage });
  expect(protocol.terminal).toEqual({ kind: "success" });
  protocol.accept({ type: "message_start", message: piAssistantMessage });
  expect(protocol.terminal).toBeUndefined();
  expect(protocol.toolUsed).toBe(true);
  protocol.accept({ type: "message_end", message: piAssistantMessage });
  expect(protocol.terminal).toEqual({ kind: "success" });
  expect(protocol.toolUsed).toBe(true);
});

test.each([
  { type: "turn_end", message: piAssistantMessage, toolResults: [] },
  { type: "turn_end", message: piAssistantMessage },
  { type: "message_start", message: { role: "user", content: "tool_execution_end" } },
  {
    type: "message_end",
    message: { ...piAssistantMessage, content: [{ type: "text", text: "toolResult" }] },
  },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tool_execution_end" },
  },
  { type: "session", message: { role: "toolResult" }, toolResults: [{}] },
])("Pi unrelated frame %j does not latch tools", (event) => {
  const protocol = new Protocol(
    { kind: "pi", provider: "anthropic", id: "claude-fable-5-1", thinking: "xhigh" },
    [],
  );
  protocol.accept(event);
  expect(protocol.toolUsed).toBe(false);
});

test("Pi unknown tool lifecycle events still throw", () => {
  const protocol = new Protocol(
    { kind: "pi", provider: "anthropic", id: "claude-fable-5-1", thinking: "xhigh" },
    [],
  );
  expect(() => protocol.accept({ type: "future_tool_execution_end" })).toThrow("Unknown Pi event");
});

const summaryRetries = {
  summarization_retry_scheduled: {
    type: "summarization_retry_scheduled",
    attempt: 1,
    maxAttempts: 1,
    delayMs: 1,
    errorMessage: "429 Too Many Requests",
  },
  summarization_retry_attempt_start: {
    type: "summarization_retry_attempt_start",
    source: "compaction",
    reason: "manual",
  },
  summarization_retry_finished: { type: "summarization_retry_finished" },
} satisfies {
  [K in Extract<AgentSessionEvent["type"], `summarization_retry_${string}`>]: Extract<
    AgentSessionEvent,
    { type: K }
  >;
};

for (const event of Object.values(summaryRetries)) {
  test(`Pi ${event.type} alone grants neither success nor fallback`, () => {
    const protocol = new Protocol(
      { kind: "pi", provider: "anthropic", id: "claude-fable-5-1", thinking: "xhigh" },
      [],
    );
    protocol.accept(event);
    expect(protocol.terminal).toBeUndefined();
    expect(protocol.toolUsed).toBe(false);
    expect(protocol.output).toBe("");
    expect(protocol.usage.turns).toBe(0);
  });

  for (const stopReason of [
    "stop",
    "error",
    "aborted",
  ] satisfies AssistantMessage["stopReason"][]) {
    test.each(piToolActivityEvents)(
      `Pi ${event.type} preserves ${stopReason} terminal and $name evidence`,
      ({ event: toolEvent }) => {
        const protocol = new Protocol(
          { kind: "pi", provider: "anthropic", id: "claude-fable-5-1", thinking: "xhigh" },
          ["write"],
        );
        protocol.accept(toolEvent);
        protocol.accept({
          type: "message_end",
          message: {
            ...piAssistantMessage,
            stopReason,
            errorMessage: "429 Too Many Requests",
          },
        });
        const terminal = protocol.terminal;
        const usage = { ...protocol.usage };
        expect(terminal).toBeDefined();
        protocol.accept(event);
        expect(protocol.terminal).toBe(terminal);
        expect(protocol.toolUsed).toBe(true);
        expect(protocol.output).toBe("pi-ok");
        expect(protocol.usage).toEqual(usage);
      },
    );
  }
}

test("Pi unknown summarization lifecycle remains rejected", () => {
  const protocol = new Protocol(
    { kind: "pi", provider: "anthropic", id: "claude-fable-5-1", thinking: "xhigh" },
    [],
  );
  expect(() => protocol.accept({ type: "summarization_retry_future" })).toThrow(
    "Unknown Pi event: summarization_retry_future",
  );
});
