import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTask } from "@earendil-works/pi-durable";
import type { ExecutionCommands } from "./execution-commands.js";
import { isIdentityName } from "./workspace-identity.js";

export const HOST_COMMAND_TASK = "herdr.command.consume";

export function hostCommandTask(options: {
  readonly assertBinding: (conversationKey: string) => Promise<void>;
  readonly owner: () => ExecutionCommands;
}) {
  return defineTask<{ intentId: string }, { phase: "start" }, { intentId: string; phase: string }>({
    name: HOST_COMMAND_TASK, version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, runtime, context) => {
        if (typeof task.input !== "object" || task.input === null || Object.keys(task.input).length !== 1 || !isIdentityName(task.input.intentId))
          throw new Error("Invalid owned command task input");
        await options.assertBinding(String(runtime.conversationId));
        const command = await options.owner().start(task.input.intentId, { kind: "task", taskKey: String(runtime.taskId), conversationKey: String(runtime.conversationId) });
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { intentId: task.input.intentId, phase: command.phase.kind } } }), context);
      },
    },
    abort: async (_task, runtime) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), BACKGROUND_CONTEXT);
    },
  });
}
