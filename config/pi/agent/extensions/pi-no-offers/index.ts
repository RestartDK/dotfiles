import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { classify } from "./classify.ts";

const NUDGE = `You ended on an offer ("<closer>") for a reversible step the task already implies. Do it now and report. A question survives only for an irreversible action, a genuine product fork, or a question the repo's AGENTS.md mandates.`;
const NUDGE_PREFIX = "You ended on an offer";
const CLOSER_PLACEHOLDER = "<closer>";

const state = { lastPrompt: "", lastAssistantText: "", nudgedThisTurn: false };

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
  pi.on("before_agent_start", (event) => {
    if (event.prompt.startsWith(NUDGE_PREFIX)) return;
    state.lastPrompt = event.prompt;
    state.nudgedThisTurn = false;
  });

  pi.on("agent_end", (event) => {
    state.lastAssistantText = lastAssistantText(event.messages);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!ctx.hasUI || !ctx.isIdle()) return;
    const verdict = classify({
      assistantText: state.lastAssistantText,
      userPrompt: state.lastPrompt,
      nudgedThisTurn: state.nudgedThisTurn,
    });
    if (!verdict.nudge) return;
    state.nudgedThisTurn = true;
    pi.sendUserMessage(NUDGE.replace(CLOSER_PLACEHOLDER, verdict.closer));
  });
}
