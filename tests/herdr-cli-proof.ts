import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "../config/pi/agent/extensions/pi-herdr/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { Check } from "../config/pi/agent/extensions/pi-herdr/node_modules/typebox/build/value/index.mjs";
import registerHerdr from "../config/pi/agent/extensions/pi-herdr/index.ts";

export default function (pi: ExtensionAPI) {
  let invoke: ((pane: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  registerHerdr({
    ...pi,
    registerTool(tool) {
      pi.registerTool(tool);
      if (tool.name !== "herdr") return;
      invoke = async (pane, ctx) => {
        const params: unknown = {
          action: "run",
          pane,
          command: "exit 7",
          wait: true,
          timeout: 10_000,
          lines: 5,
        };
        assert.ok(Check(tool.parameters, params));
        const result = await tool.execute("cli-proof", params, undefined, undefined, {
          ...ctx,
          tools: [],
          executeTool: async () => {
            throw new Error("The Herdr proof must not invoke nested tools");
          },
        });
        const details: unknown = result.details;
        assert.ok(
          details && typeof details === "object" && "state" in details && details.state === "done",
        );
        assert.ok("exitCode" in details && details.exitCode === 7);
      };
    },
  });
  pi.registerCommand("env137-proof", {
    description: "Invoke the registered production Herdr callback with a real CLI session",
    handler: async (pane, ctx) => {
      assert.ok(invoke);
      await invoke(pane.trim(), ctx);
      process.stdout.write("PI_CLI_HERDR_PROOF_OK\n");
      ctx.shutdown();
    },
  });
}
