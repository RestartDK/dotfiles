import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

export const piAssistantMessage = {
  role: "assistant",
  provider: "fireworks",
  model: "accounts/fireworks/models/deepseek-v4p1-flash",
  api: "anthropic-messages",
  content: [{ type: "text", text: "pi-ok" }],
  stopReason: "stop",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  timestamp: 0,
} satisfies AssistantMessage;

const toolResult = {
  role: "toolResult",
  toolCallId: "write-1",
  toolName: "write",
  content: [{ type: "text", text: "Wrote end-only-write.txt" }],
  isError: false,
  timestamp: 0,
} satisfies ToolResultMessage;

export const piWriteEnd = {
  type: "tool_execution_end",
  toolCallId: toolResult.toolCallId,
  toolName: toolResult.toolName,
  result: { content: toolResult.content },
  isError: false,
} satisfies AgentEvent;

export const piToolActivityEvents = [
  {
    name: "tool_execution_start",
    event: {
      type: "tool_execution_start",
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      args: { path: "end-only-write.txt", content: "write\n" },
    } satisfies AgentEvent,
  },
  {
    name: "tool_execution_update",
    event: {
      type: "tool_execution_update",
      toolCallId: toolResult.toolCallId,
      toolName: toolResult.toolName,
      args: { path: "end-only-write.txt", content: "write\n" },
      partialResult: { content: toolResult.content },
    } satisfies AgentEvent,
  },
  { name: "tool_execution_end", event: piWriteEnd },
  { name: "tool_execution_end error", event: { ...piWriteEnd, isError: true } },
  { name: "tool_result_end", event: { type: "tool_result_end" } },
  ...(["message_start", "message_update", "message_end"] satisfies AgentEvent["type"][]).map(
    (type) => ({
      name: `${type} toolResult`,
      event: { type, message: toolResult },
    }),
  ),
  {
    name: "turn_end toolResults",
    event: {
      type: "turn_end",
      message: piAssistantMessage,
      toolResults: [toolResult],
    } satisfies AgentEvent,
  },
];
