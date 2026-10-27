import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  parseUltrafastMode,
  supportsUltrafast,
  ULTRAFAST_STATUS_KEY,
  ultrafastPayload,
  type UltrafastMode,
} from "./state.ts";

export default function ultrafast(pi: ExtensionAPI) {
  let mode: UltrafastMode = "off";

  function updateStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      ULTRAFAST_STATUS_KEY,
      mode === "on" && supportsUltrafast(ctx.model) ? "ultrafast" : undefined,
    );
  }

  function reset(_event: unknown, ctx: ExtensionContext) {
    mode = "off";
    updateStatus(ctx);
  }

  pi.registerCommand("ultrafast", {
    description: "Toggle Ultrafast for OpenAI Sol/Astra. Optional on or off.",
    handler: async (args, ctx) => {
      const next = parseUltrafastMode(args, mode);
      if (next === undefined) {
        ctx.ui.notify("Usage: /ultrafast [on|off]", "warning");
        return;
      }
      if (next === "on" && !supportsUltrafast(ctx.model)) {
        ctx.ui.notify("Ultrafast requires OpenAI GPT-6.1 Sol or GPT-6 Astra.", "warning");
        return;
      }
      mode = next;
      updateStatus(ctx);
      ctx.ui.notify(
        mode === "on"
          ? "Ultrafast on. Higher quota/credit use. Reasoning is unchanged."
          : "Ultrafast off.",
        "info",
      );
    },
  });

  pi.on("before_provider_request", (event, ctx) =>
    ultrafastPayload(event.payload, mode, ctx.model),
  );
  pi.on("session_start", reset);
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", reset);
}
