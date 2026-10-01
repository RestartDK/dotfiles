import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../lib/model-policy";

export type PiActivity = Extract<
  AgentSessionEvent["type"],
  | "agent_start"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "tool_execution_start"
  | "auto_retry_start"
  | "auto_retry_end"
  | "compaction_start"
  | "compaction_end"
  | "agent_settled"
>;

const piActivityTypes = {
  agent_start: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  tool_execution_start: true,
  auto_retry_start: true,
  auto_retry_end: true,
  compaction_start: true,
  compaction_end: true,
  agent_settled: true,
} satisfies Record<PiActivity, true>;

export function isPiActivity(type: AgentSessionEvent["type"]): type is PiActivity {
  return type in piActivityTypes;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}
export function initialUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}
export type Failure = "auth" | "quota" | "unavailable";
const httpFailure = (status: unknown): Failure | undefined => {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529)
    return "unavailable";
  return undefined;
};
const nativeHttpStatuses = new Map<string, readonly number[]>([
  ["authentication_error", [401]],
  ["permission_error", [403]],
  ["rate_limit_error", [429]],
  ["rate_limit_exceeded", [429]],
  ["insufficient_quota", [429]],
  ["api_error", [500]],
  ["overloaded_error", [529]],
  ["server_error", [500, 503]],
]);
export function piFailure(message: string): Failure | undefined {
  if (Buffer.byteLength(message) > 4096) return undefined;
  const native = /^(?:(\d{3}) |OpenAI API error \((\d{3})\): )(\{[\s\S]*\})$/.exec(message);
  if (native) {
    try {
      const parsed: unknown = JSON.parse(native[3] ?? "");
      if (!isRecord(parsed)) return undefined;
      const status = Number(native[1] ?? native[2]);
      const error = native[1]
        ? parsed.type === "error" && isRecord(parsed.error)
          ? parsed.error
          : undefined
        : parsed;
      if (
        !error ||
        typeof error.type !== "string" ||
        typeof error.message !== "string" ||
        (parsed.status !== undefined && parsed.status !== status) ||
        (error.status !== undefined && error.status !== status)
      )
        return undefined;
      if (native[2] && error.type === "invalid_request_error")
        return status === 401 && error.code === "invalid_api_key" ? "auth" : undefined;
      if (error.code !== undefined && error.code !== null && error.code !== error.type)
        return undefined;
      return nativeHttpStatuses.get(error.type)?.includes(status) ? httpFailure(status) : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const parsed: unknown = JSON.parse(message);
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : parsed;
      return httpFailure(parsed.status) ?? httpFailure(error.status);
    }
  } catch {}
  if (
    /^(?:401|403) (?:Unauthorized|Forbidden)(?:[.:\s]|$)/.test(message) ||
    /^No API key found for (?:openai|openai-codex|anthropic|fireworks|openrouter)\.$/.test(
      message,
    ) ||
    /^No API key for [a-z0-9-]+\/[^\s]+$/.test(message) ||
    message.startsWith('Authentication failed for "')
  )
    return "auth";
  if (/^429 (?:Too Many Requests|rate_limit_error)(?:[.:\s]|$)/.test(message)) return "quota";
  if (
    /^(?:500|502|503|504|529) (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Overloaded)(?:[.:\s]|$)/.test(
      message,
    )
  )
    return "unavailable";
  return undefined;
}
export function capped(text: string, bytes = 50 * 1024): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  return (
    Buffer.from(text)
      .subarray(0, bytes - 32)
      .toString("utf8") + "\n[output truncated]"
  );
}
