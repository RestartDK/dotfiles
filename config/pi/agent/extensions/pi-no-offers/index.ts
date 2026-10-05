import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { classify } from "./classify.ts";

type ContentBlock = { type: string; text?: string };
type MessageLike = { role: string; content?: string | readonly ContentBlock[] };

function messageText(content: string | readonly ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function lastAssistantText(messages: readonly MessageLike[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.content !== undefined) {
      return messageText(message.content);
    }
  }
  return "";
}

export default function piNoOffers(pi: ExtensionAPI): void {
  const state = { lastPrompt: "", lastAssistantText: "", warnedThisTurn: false };
  pi.on("before_agent_start", (event) => {
    state.lastPrompt = event.prompt;
    state.warnedThisTurn = false;
  });

  pi.on("agent_end", (event) => {
    state.lastAssistantText = lastAssistantText(event.messages);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.hasUI || !ctx.isIdle()) return;
    const verdict = classify({
      assistantText: state.lastAssistantText,
      userPrompt: state.lastPrompt,
      warnedThisTurn: state.warnedThisTurn,
    });
    if (verdict.kind !== "warning") return;
    state.warnedThisTurn = true;
    ctx.ui.notify(
      `Dstack offer warning: "${verdict.closer}". No continuation was scheduled.`,
      "warning",
    );
  });
}
