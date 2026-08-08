import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part: any) => {
      if (part?.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pick", {
    description:
      "Start a new empty session using a previous user or assistant message as the prompt",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const sourceSession = ctx.sessionManager.getSessionFile();
      const messages = ctx.sessionManager
        .getBranch()
        .filter(
          (entry: any) => entry.message?.role === "user" || entry.message?.role === "assistant",
        )
        .map((entry: any, index: number) => {
          const role = entry.message.role === "assistant" ? "assistant" : "user";
          const text = textFromContent(entry.message.content);
          const firstLine = text.replace(/\s+/g, " ").trim();
          const labelText = firstLine.length > 82 ? `${firstLine.slice(0, 82)}…` : firstLine;
          return {
            key: `${index + 1}. ${role}: ${labelText}`,
            text,
          };
        })
        .filter((message) => message.text.trim().length > 0);

      if (messages.length === 0) {
        ctx.ui.notify("No user or assistant messages found", "warning");
        return;
      }

      const choice = await ctx.ui.select(
        "Pick a user or assistant message to start a fresh session from:",
        messages.map((message) => message.key),
      );

      if (!choice) return;

      const selected = messages.find((message) => message.key === choice);
      if (!selected) return;

      await ctx.newSession({
        parentSession: sourceSession,
        withSession: async (newCtx) => {
          newCtx.ui.setEditorText(selected.text);
          newCtx.ui.notify("Started a fresh session with the picked prompt", "success");
        },
      });
    },
  });
}
