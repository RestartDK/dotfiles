import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import {
  BINDING_ENTRY,
  LIMITS,
  TaskRunner,
  WriterGate,
  canonicalCheckout,
  ownedProcess,
  parseBinding,
  preflight,
  resolveClaude,
} from "./core.ts";

const gate = new WriterGate();
const writers = new Set(["write", "edit", "bash", "powershell"]);
export default function claudeTask(pi: ExtensionAPI): void {
  const runner = new TaskRunner(gate, {
    query,
    canonicalCheckout,
    resolveClaude,
    preflight,
    ownedProcess,
    runtimeMs: LIMITS.runtimeMs,
  });
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    runner.bindings.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== BINDING_ENTRY) continue;
      const binding = parseBinding(entry.data);
      if (binding) runner.bindings.set(binding.sessionId, binding);
    }
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_before_switch", () => runner.stop());
  pi.on("session_before_tree", () => runner.stop());
  pi.on("session_before_fork", () => runner.stop());
  pi.on("session_shutdown", () => runner.stop());
  pi.on("tool_call", (event) => {
    if (!writers.has(event.toolName)) return;
    try {
      gate.beginLocal(event.toolCallId);
    } catch (error) {
      return { block: true, reason: String(error) };
    }
  });
  pi.on("tool_execution_end", (event) => {
    if (writers.has(event.toolName)) gate.endLocal(event.toolCallId);
  });
  pi.on("user_bash", () => {
    if (gate.busy)
      throw new Error(
        "Claude owns the checkout. Cancel claude_task before running a local shell command.",
      );
  });
  pi.registerTool({
    name: "claude_task",
    label: "Claude Code task",
    description:
      "Delegate a whole task to the installed Claude Code agent using its own claude.ai login. Runs synchronously in an absolute Git checkout. Shell and file writes require human approval. Do not schedule Pi writers alongside it. Resume only with a session id returned on this Pi branch for the same checkout. Limits: 30 turns, $5 estimated spend, 15 minutes. No background tasks.",
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 32_000 }),
      cwd: Type.String({ minLength: 1 }),
      resume: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await runner.execute({
        toolCallId,
        params,
        signal,
        ui: ctx,
        bind: (binding) => pi.appendEntry(BINDING_ENTRY, binding),
        cleanupError: (message) => ctx.ui.notify(message, "error"),
        update: (text, sessionId) =>
          onUpdate?.({
            content: [{ type: "text", text }],
            details: { status: "running", cwd: params.cwd, sessionId, toolCallId },
          }),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: { ...result, toolCallId },
        usage: result.usage,
        isError: result.status !== "success",
      };
    },
  });
}
