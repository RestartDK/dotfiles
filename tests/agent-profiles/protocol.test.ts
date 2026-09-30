import { expect, test } from "bun:test";
import { piFailure, type Failure } from "../../config/pi/agent/extensions/subagents/protocol";

const piError = (message: string) => piFailure(message);

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
  expect(piError(message)).toBe(failure);
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
  expect(piError(message)).toBeUndefined();
});

test("provider classification is bounded to 4096 bytes", () => {
  const prefix = '429 {"type":"error","error":{"type":"rate_limit_error","message":"';
  const suffix = '"}}';
  const exact = prefix + "x".repeat(4096 - prefix.length - suffix.length) + suffix;
  expect(Buffer.byteLength(exact)).toBe(4096);
  expect(piError(exact)).toBe("quota");
  expect(piError(exact.replace('"message":"', '"message":"x'))).toBeUndefined();
  const multibyte = prefix + "å".repeat(2100) + suffix;
  expect(multibyte.length).toBeLessThan(4096);
  expect(Buffer.byteLength(multibyte)).toBeGreaterThan(4096);
  expect(piError(multibyte)).toBeUndefined();
});

test.each([
  ['{"status":429}', "quota"],
  ['{"error":{"status":401}}', "auth"],
  ['{"error":{"type":"overloaded"}}', "unavailable"],
  ["401 Unauthorized", "auth"],
  ["No API key found for fireworks.", "auth"],
  ["No API key for openrouter/deepseek-v4.1-flash", "auth"],
  ['Authentication failed for "openai-codex". Log in with pi login.', "auth"],
  ["429 Too Many Requests", "quota"],
  ["429 rate_limit_error", "quota"],
  ["503 Service Unavailable", "unavailable"],
  ["rate_limit", "quota"],
] satisfies [string, Failure][])(
  "existing provider error format %s remains accepted",
  (message, failure) => {
    expect(piError(message)).toBe(failure);
  },
);
