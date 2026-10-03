import { describe, expect, test } from "bun:test";
import { fetchUsageWindows, USAGE_SOURCES, usageProviderId, type UsageModel } from "./usage.ts";

const resetsAt = "2030-01-01T00:00:00Z";
const resetAt = 1_893_456_000;
const goWindow = { status: "ok", percent: 1, resetsAt };
const goBody = {
  usage: {
    rolling: goWindow,
    weekly: { status: "rate-limited", percent: 100, resetsAt },
    monthly: { status: "ok", percent: 0, resetsAt },
  },
};
const goWindows = [
  { label: "5h", percent: 1, resetAt },
  { label: "wk", percent: 100, resetAt },
  { label: "mo", percent: 0, resetAt },
];

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("usage decoding", () => {
  test("Go preserves percentage points, horizon order and ISO resets", () => {
    expect(USAGE_SOURCES.get("opencode-go")?.decode(goBody)).toEqual(goWindows);
  });

  test.each([
    { name: "unknown status", window: { ...goWindow, status: "unknown" } },
    { name: "non-integer percent", window: { ...goWindow, percent: 1.5 } },
    { name: "percent above 100", window: { ...goWindow, percent: 101 } },
    { name: "negative percent", window: { ...goWindow, percent: -1 } },
    { name: "non-numeric percent", window: { ...goWindow, percent: "1" } },
    { name: "missing resetsAt", window: { status: "ok", percent: 1 } },
    { name: "invalid resetsAt", window: { ...goWindow, resetsAt: "invalid" } },
    { name: "missing window", window: undefined },
  ])("Go omits $name without hiding valid horizons", ({ window }) => {
    expect(
      USAGE_SOURCES.get("opencode-go")?.decode({
        usage: { ...goBody.usage, weekly: window },
      }),
    ).toEqual([goWindows[0], goWindows[2]]);
  });

  test("Claude utilization fractions become percentage points", () => {
    expect(
      USAGE_SOURCES.get("anthropic")?.decode({
        five_hour: { utilization: 1, resets_at: resetsAt },
        seven_day: { utilization: 0.5, resets_at: resetsAt },
      }),
    ).toEqual([
      { label: "5h", percent: 100, resetAt },
      { label: "7d", percent: 50, resetAt },
    ]);
  });

  test("Codex keeps percentage points and derives horizon labels from seconds", () => {
    expect(
      USAGE_SOURCES.get("openai-codex")?.decode({
        rate_limit: {
          primary_window: { used_percent: 1, limit_window_seconds: 18_000, reset_at: resetAt },
          secondary_window: {
            used_percent: 100,
            limit_window_seconds: 604_800,
            reset_at: resetAt,
          },
        },
      }),
    ).toEqual([
      { label: "5h", percent: 1, resetAt },
      { label: "7d", percent: 100, resetAt },
    ]);
  });
});

describe("usage fetching", () => {
  test.each([
    {
      name: "missing key",
      provider: "opencode-go",
      key: undefined,
      status: 200,
      body: goBody,
      calls: 0,
      windows: [],
    },
    {
      name: "401 response",
      provider: "opencode-go",
      key: "fixture-key",
      status: 401,
      body: goBody,
      calls: 1,
      windows: [],
    },
    {
      name: "missing usage",
      provider: "opencode-go",
      key: "fixture-key",
      status: 200,
      body: {},
      calls: 1,
      windows: [],
    },
    {
      name: "valid Go response",
      provider: "opencode-go",
      key: "fixture-key",
      status: 200,
      body: goBody,
      calls: 1,
      windows: goWindows,
    },
    {
      name: "unknown provider",
      provider: "unknown",
      key: "fixture-key",
      status: 200,
      body: goBody,
      calls: 0,
      windows: [],
    },
  ])(
    "handles $name without live credentials or HTTP",
    async ({ provider, key, status, body, calls, windows }) => {
      const originalFetch = globalThis.fetch;
      const requests: Array<{ url: string; headers: Headers }> = [];
      globalThis.fetch = (async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return Response.json(body, { status });
      }) as typeof fetch;
      try {
        expect(await fetchUsageWindows(provider, async () => key)).toEqual(windows);
        expect(requests).toHaveLength(calls);
        for (const request of requests) {
          expect(request.url).toBe("https://opencode.ai/zen/go/v1/usage");
          expect(request.headers.get("Authorization")).toBe("Bearer fixture-key");
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  test("resolver failures yield no usage", async () => {
    expect(
      await fetchUsageWindows("opencode-go", async () => {
        throw new Error("resolver failed");
      }),
    ).toEqual([]);
  });
});

describe("usage provider eligibility", () => {
  test.each([
    { name: "undefined model", model: undefined },
    { name: "unknown provider", model: { provider: "unknown", cost: { ...zeroCost, input: 1 } } },
    { name: "all-zero base rates", model: { provider: "opencode-go", cost: zeroCost } },
    {
      name: "all-zero base and tier rates",
      model: {
        provider: "opencode-go",
        cost: { ...zeroCost, tiers: [{ ...zeroCost, inputTokensAbove: 100 }] },
      },
    },
  ] satisfies Array<{ name: string; model: UsageModel | undefined }>)(
    "hides $name",
    ({ model }) => {
      expect(usageProviderId(model)).toBeUndefined();
    },
  );

  test.each(["input", "output", "cacheRead", "cacheWrite"] as const)(
    "a nonzero %s base rate enables usage",
    (rate) => {
      expect(usageProviderId({ provider: "opencode-go", cost: { ...zeroCost, [rate]: 1 } })).toBe(
        "opencode-go",
      );
    },
  );

  test.each(["input", "output", "cacheRead", "cacheWrite"] as const)(
    "a nonzero %s tier rate enables usage even when base rates are zero",
    (rate) => {
      expect(
        usageProviderId({
          provider: "opencode-go",
          cost: { ...zeroCost, tiers: [{ ...zeroCost, inputTokensAbove: 100, [rate]: 1 }] },
        }),
      ).toBe("opencode-go");
    },
  );
});
