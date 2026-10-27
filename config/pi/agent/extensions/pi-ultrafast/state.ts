import type { Api, Model } from "@earendil-works/pi-ai";

export const ULTRAFAST_STATUS_KEY = "ultrafast";
export type UltrafastMode = "off" | "on";
export type UltrafastModel = Pick<Model<Api>, "provider" | "api" | "id">;

export function supportsUltrafast(model: UltrafastModel | undefined): boolean {
  return (
    model?.provider === "openai" &&
    model.api === "openai-responses" &&
    (model.id === "gpt-6.1-sol" || model.id === "gpt-6-astra")
  );
}

export function parseUltrafastMode(
  args: string,
  current: UltrafastMode,
): UltrafastMode | undefined {
  switch (args.trim().toLowerCase()) {
    case "":
      return current === "on" ? "off" : "on";
    case "on":
      return "on";
    case "off":
      return "off";
    default:
      return undefined;
  }
}

export function ultrafastPayload(
  payload: unknown,
  mode: UltrafastMode,
  model: UltrafastModel | undefined,
): object | undefined {
  if (mode !== "on" || !supportsUltrafast(model)) return undefined;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  if (
    !("model" in payload) ||
    (payload.model !== "gpt-6.1-sol" && payload.model !== "gpt-6-astra")
  ) {
    return undefined;
  }
  return { ...payload, service_tier: "ultrafast" };
}
