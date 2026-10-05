import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut(Key.ctrlAlt("c"), {
    description: "Copy the editor text to the clipboard",
    handler: async (ctx) => {
      const text = ctx.ui.getEditorText();
      if (text.trim().length === 0) {
        ctx.ui.notify("Nothing to copy", "warning");
        return;
      }

      try {
        await copyToClipboard(text);
        ctx.ui.notify("Copied editor text", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
