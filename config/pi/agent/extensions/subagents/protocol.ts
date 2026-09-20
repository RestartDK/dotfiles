import { isRecord, type Backend } from "./policy";

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
export type Terminal =
  | { kind: "success" }
  | { kind: "failure"; reason: string; provider?: Failure };
const providerErrors = new Map<string, Failure>([
  ["authentication_failed", "auth"],
  ["oauth_org_not_allowed", "auth"],
  ["account_on_hold", "auth"],
  ["billing_error", "quota"],
  ["rate_limit", "quota"],
  ["overloaded", "unavailable"],
  ["model_not_found", "unavailable"],
  ["server_error", "unavailable"],
  ["cloud_credential_error", "auth"],
]);
const httpFailure = (status: unknown): Failure | undefined => {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529)
    return "unavailable";
  return undefined;
};
function piFailure(message: string): Failure | undefined {
  if (message.length > 4096) return undefined;
  try {
    const parsed: unknown = JSON.parse(message);
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : parsed;
      return (
        httpFailure(parsed.status) ??
        httpFailure(error.status) ??
        (typeof error.type === "string" ? providerErrors.get(error.type) : undefined)
      );
    }
  } catch {}
  if (
    /^(?:401|403) (?:Unauthorized|Forbidden)(?:[.:\s]|$)/.test(message) ||
    /^No API key found for (?:openai|openai-codex|anthropic|fireworks|openrouter)\.$/.test(message)
  )
    return "auth";
  if (/^429 (?:Too Many Requests|rate_limit_error)(?:[.:\s]|$)/.test(message)) return "quota";
  if (
    /^(?:500|502|503|504|529) (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Overloaded)(?:[.:\s]|$)/.test(
      message,
    )
  )
    return "unavailable";
  return providerErrors.get(message);
}
export function capped(text: string, bytes = 50 * 1024): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  return (
    Buffer.from(text)
      .subarray(0, bytes - 32)
      .toString("utf8") + "\n[output truncated]"
  );
}
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export class Protocol {
  readonly usage = initialUsage();
  output = "";
  actualModel?: string;
  terminal?: Terminal;
  toolUsed = false;
  resetAt?: number;
  private initialized = false;
  private assistantError?: string;

  constructor(
    readonly backend: Backend,
    readonly tools: string[],
  ) {}

  accept(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string")
      throw new Error("Malformed backend event");
    if (this.backend.kind === "pi") {
      if (
        ![
          "session",
          "agent_start",
          "agent_end",
          "agent_settled",
          "turn_start",
          "turn_end",
          "message_start",
          "message_update",
          "message_end",
          "tool_execution_start",
          "tool_execution_update",
          "tool_execution_end",
          "tool_result_end",
          "queue_update",
          "compaction_start",
          "compaction_end",
          "auto_compaction_start",
          "auto_compaction_end",
          "auto_retry_start",
          "auto_retry_end",
        ].includes(value.type)
      )
        throw new Error(`Unknown Pi event: ${value.type}`);
      this.pi(value);
    } else this.claude(value);
  }

  private message(value: unknown): Record<string, unknown> {
    if (!isRecord(value) || !Array.isArray(value.content))
      throw new Error("Malformed assistant message");
    const texts: string[] = [];
    for (const block of value.content) {
      if (
        !isRecord(block) ||
        typeof block.type !== "string" ||
        !["text", "thinking", "redacted_thinking", "tool_use", "toolCall"].includes(block.type)
      )
        throw new Error("Malformed assistant content");
      if (block.type === "text" && typeof block.text !== "string")
        throw new Error("Malformed assistant text");
      if (block.type === "tool_use" || block.type === "toolCall") this.toolUsed = true;
      if (
        block.type === "tool_use" &&
        (typeof block.name !== "string" || !this.tools.includes(block.name))
      )
        throw new Error("Claude requested an unapproved tool");
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
    if (texts.length) this.output = capped(texts.join("\n"));
    if (typeof value.model !== "string") throw new Error("Missing actual model");
    const expected =
      this.backend.kind === "pi"
        ? this.backend.model.slice(this.backend.model.indexOf("/") + 1)
        : this.backend.model;
    if (this.backend.kind === "pi" && typeof value.provider !== "string")
      throw new Error("Missing actual Pi provider");
    this.actualModel =
      this.backend.kind === "pi" ? `${value.provider}/${value.model}` : value.model;
    if (
      value.model !== expected ||
      (this.backend.kind === "pi" && this.actualModel !== this.backend.model)
    )
      throw new Error("Backend returned an unexpected model/provider");
    return value;
  }

  private pi(event: Record<string, unknown>): void {
    if (
      event.type === "message_start" &&
      isRecord(event.message) &&
      event.message.role === "assistant"
    ) {
      this.message(event.message);
      this.terminal = undefined;
    }
    if (event.type === "tool_execution_start") {
      this.toolUsed = true;
      this.terminal = undefined;
    }
    if (
      event.type !== "message_end" ||
      !isRecord(event.message) ||
      event.message.role !== "assistant"
    )
      return;
    const message = this.message(event.message);
    this.usage.turns++;
    if (isRecord(message.usage)) {
      const usage = message.usage;
      this.usage.input += number(usage.input);
      this.usage.output += number(usage.output);
      this.usage.cacheRead += number(usage.cacheRead);
      this.usage.cacheWrite += number(usage.cacheWrite);
      this.usage.contextTokens = number(usage.totalTokens);
      if (isRecord(usage.cost)) this.usage.cost += number(usage.cost.total);
    }
    if (message.stopReason === "error") {
      const reason =
        typeof message.errorMessage === "string" ? message.errorMessage : "Unknown Pi error";
      this.terminal = {
        kind: "failure",
        reason: capped(reason, 4096),
        provider: piFailure(reason),
      };
    } else if (message.stopReason === "stop" || message.stopReason === "length") {
      this.terminal = { kind: "success" };
    } else if (message.stopReason === "aborted") {
      this.terminal = { kind: "failure", reason: "Pi aborted" };
    } else if (message.stopReason === "toolUse") this.terminal = undefined;
    else throw new Error("Unknown Pi stop reason");
  }

  private claude(event: Record<string, unknown>): void {
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") this.actualModel = event.model;
      if (
        this.initialized ||
        event.model !== this.backend.model ||
        !Array.isArray(event.tools) ||
        event.tools.length !== this.tools.length ||
        !this.tools.every((tool) => Array.isArray(event.tools) && event.tools.includes(tool)) ||
        event.permissionMode !== "dontAsk" ||
        event.apiKeySource !== "none" ||
        !Array.isArray(event.mcp_servers) ||
        event.mcp_servers.length !== 0
      )
        throw new Error("Claude init model, auth or tool scope mismatch");
      this.initialized = true;
      this.actualModel = event.model;
    } else if (
      event.type === "system" &&
      (event.subtype === "hook_started" || event.subtype === "hook_response")
    ) {
      throw new Error("Claude hooks were not disabled");
    } else if (event.type === "assistant") {
      if (!this.initialized || this.terminal)
        throw new Error("Claude assistant outside active session");
      this.message(event.message);
      if (event.error !== undefined && typeof event.error !== "string")
        throw new Error("Malformed Claude assistant error");
      if (typeof event.error === "string") this.assistantError = event.error;
      this.usage.turns++;
    } else if (event.type === "rate_limit_event") {
      if (
        !isRecord(event.rate_limit_info) ||
        !["allowed", "allowed_warning", "rejected"].includes(String(event.rate_limit_info.status))
      )
        throw new Error("Malformed rate limit event");
      if (event.rate_limit_info.status === "rejected") {
        const reset = number(event.rate_limit_info.resetsAt);
        if (reset) this.resetAt = reset < 1e12 ? reset * 1000 : reset;
      }
    } else if (event.type === "result") {
      if (!this.initialized || this.terminal)
        throw new Error("Missing init or duplicate Claude result");
      if (
        typeof event.subtype !== "string" ||
        typeof event.is_error !== "boolean" ||
        typeof event.terminal_reason !== "string" ||
        !(
          event.api_error_status === null ||
          (typeof event.api_error_status === "number" &&
            Number.isInteger(event.api_error_status) &&
            event.api_error_status >= 100 &&
            event.api_error_status < 600)
        )
      )
        throw new Error("Malformed Claude terminal result");
      if (isRecord(event.usage)) {
        this.usage.input = number(event.usage.input_tokens);
        this.usage.output = number(event.usage.output_tokens);
        this.usage.cacheRead = number(event.usage.cache_read_input_tokens);
        this.usage.cacheWrite = number(event.usage.cache_creation_input_tokens);
        this.usage.contextTokens = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite;
      }
      this.usage.turns = number(event.num_turns);
      this.usage.cost = number(event.total_cost_usd);
      if (typeof event.result === "string") this.output = capped(event.result);
      if (
        event.subtype === "success" &&
        event.is_error === false &&
        event.terminal_reason === "completed"
      ) {
        this.terminal = { kind: "success" };
      } else if (event.is_error === true) {
        this.terminal = {
          kind: "failure",
          reason: this.assistantError ?? `Claude ${String(event.subtype)}`,
          provider:
            event.subtype === "error_during_execution" &&
            ["api_error", "model_error", "blocking_limit"].includes(event.terminal_reason)
              ? (httpFailure(event.api_error_status) ??
                providerErrors.get(this.assistantError ?? ""))
              : undefined,
        };
      } else throw new Error("Malformed Claude result");
    } else if (
      event.type === "user" ||
      event.type === "tool_progress" ||
      event.type === "tool_use_summary"
    ) {
      this.toolUsed = true;
    } else if (event.type === "prompt_suggestion") {
      return;
    } else if (
      event.type === "system" &&
      ["thinking_tokens", "status", "compact_boundary", "api_retry", "turn_duration"].includes(
        String(event.subtype),
      )
    ) {
      return;
    } else throw new Error(`Unknown Claude event: ${event.type}/${String(event.subtype)}`);
  }
}
