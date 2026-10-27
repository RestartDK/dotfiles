import { describe, expect, test } from "bun:test";
import {
  parseUltrafastMode,
  supportsUltrafast,
  ultrafastPayload,
  type UltrafastModel,
} from "./state.ts";

const sol = {
  provider: "openai",
  api: "openai-responses",
  id: "gpt-6.1-sol",
} satisfies UltrafastModel;

describe("Ultrafast request policy", () => {
  test.each(["gpt-6.1-sol", "gpt-6-astra"])("supports %s without changing reasoning", (id) => {
    const model = { ...sol, id };
    const payload = { model: id, reasoning: { effort: "max" }, input: [], service_tier: "auto" };
    const result = ultrafastPayload(payload, "on", model);
    expect(result).toEqual({ ...payload, service_tier: "ultrafast" });
    expect(payload.service_tier).toBe("auto");
    expect(payload.reasoning.effort).toBe("max");
  });

  test.each([
    undefined,
    { ...sol, provider: "openai-codex" },
    { ...sol, provider: "openrouter" },
    { ...sol, api: "openai-completions" },
    { ...sol, id: "gpt-5" },
  ] satisfies Array<UltrafastModel | undefined>)("leaves unsupported models alone: %j", (model) => {
    expect(supportsUltrafast(model)).toBe(false);
    expect(ultrafastPayload({ model: "gpt-6.1-sol" }, "on", model)).toBeUndefined();
  });

  test("off leaves an existing request untouched", () => {
    const payload = { model: sol.id, reasoning: { effort: "xhigh" }, service_tier: "auto" };
    expect(ultrafastPayload(payload, "off", sol)).toBeUndefined();
    expect(payload).toEqual({
      model: sol.id,
      reasoning: { effort: "xhigh" },
      service_tier: "auto",
    });
  });

  test.each([
    { payload: null },
    { payload: [] },
    { payload: "invalid" },
    { payload: {} },
    { payload: { model: "other-model" } },
  ])("does not inject into $payload", ({ payload }) => {
    expect(ultrafastPayload(payload, "on", sol)).toBeUndefined();
  });
});

describe("Ultrafast command", () => {
  test("bare command toggles in both directions", () => {
    expect(parseUltrafastMode("", "off")).toBe("on");
    expect(parseUltrafastMode("", "on")).toBe("off");
  });

  test("explicit modes are idempotent and tolerate whitespace", () => {
    expect(parseUltrafastMode(" ON ", "on")).toBe("on");
    expect(parseUltrafastMode("off", "off")).toBe("off");
    expect(parseUltrafastMode("on", "off")).toBe("on");
    expect(parseUltrafastMode("off", "on")).toBe("off");
  });

  test("invalid input does not choose a new mode", () => {
    expect(parseUltrafastMode("yes", "off")).toBeUndefined();
  });
});
