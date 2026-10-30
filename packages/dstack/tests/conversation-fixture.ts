import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  GenerationTask,
  LiveDoc,
  ProviderDoc,
  ToolTask,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { BashToolInput } from "@earendil-works/pi-durable/tools";
import {
  CodingWorkspaceOwner,
  type OpenCodingWorkspaceOptions,
} from "#coding-workspace";

export type RestartKind = "generation" | "unsafe-tool";

type CheckpointIdentity = {
  readonly rootId: number;
  readonly providerSessionId: string;
  readonly submissionId: number;
  readonly taskId: number;
};

export type RestartCheckpoint = CheckpointIdentity & (
  | { readonly kind: "generation"; readonly phase: "request" }
  | {
      readonly kind: "unsafe-tool";
      readonly phase: "execute";
      readonly replay: "unsafe";
      readonly toolPid: number;
    }
);

export function fixtureRuntime(root: string, responses: FauxResponseStep[]) {
  const faux = fauxProvider({
    api: "conversation-fixture",
    provider: "conversation-fixture",
    models: [{ id: "coding", input: ["text"] }],
    tokenSize: { min: 4096, max: 4096 },
  });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const options: OpenCodingWorkspaceOptions = {
    stateDirectory: join(root, "state"),
    workspace: {
      domain: "personal",
      nodeId: "fixture-node",
      workspaceId: "fixture-workspace",
      cwd: join(root, "worktree"),
    },
    execution: "trusted-user",
    lockCommand: { file: process.env.DSTACK_FLOCK || "flock", args: [] },
    models,
    model: { provider: model.provider, modelId: model.id },
  };
  return { options, faux };
}

export function parseRestartCheckpoint(value: unknown): RestartCheckpoint {
  assert.ok(typeof value === "object" && value !== null);
  assert.ok(
    "rootId" in value && typeof value.rootId === "number" &&
    Number.isSafeInteger(value.rootId) && value.rootId > 0,
  );
  assert.ok(
    "providerSessionId" in value && typeof value.providerSessionId === "string" &&
    value.providerSessionId.length > 0,
  );
  assert.ok(
    "submissionId" in value && typeof value.submissionId === "number" &&
    Number.isSafeInteger(value.submissionId) && value.submissionId > 0,
  );
  assert.ok(
    "taskId" in value && typeof value.taskId === "number" &&
    Number.isSafeInteger(value.taskId) && value.taskId > 0,
  );
  const identity: CheckpointIdentity = {
    rootId: value.rootId,
    providerSessionId: value.providerSessionId,
    submissionId: value.submissionId,
    taskId: value.taskId,
  };
  assert.ok("kind" in value && "phase" in value);
  if (value.kind === "generation" && value.phase === "request")
    return { ...identity, kind: "generation", phase: "request" };
  assert.equal(value.kind, "unsafe-tool");
  assert.equal(value.phase, "execute");
  assert.ok("replay" in value && value.replay === "unsafe");
  assert.ok(
    "toolPid" in value && typeof value.toolPid === "number" &&
    Number.isSafeInteger(value.toolPid) && value.toolPid > 1,
  );
  return {
    ...identity,
    kind: "unsafe-tool",
    phase: "execute",
    replay: "unsafe",
    toolPid: value.toolPid,
  };
}

async function sendCheckpoint(checkpoint: RestartCheckpoint): Promise<void> {
  const send = process.send;
  assert.ok(send, "Restart fixture requires an IPC parent");
  await new Promise<void>((resolve, reject) => {
    send.call(process, checkpoint, (error: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function restartWorker(kind: RestartKind, root: string): Promise<void> {
  const context = withAbortSignal(AbortSignal.timeout(20_000), BACKGROUND_CONTEXT);
  const requested = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  process.once("disconnect", disconnected.resolve);
  const runtime = fixtureRuntime(root, kind === "generation"
    ? [async (_transcript, options) => {
        const signal = options?.signal;
        assert.ok(signal);
        requested.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage("", { stopReason: "aborted" });
      }]
    : [fauxAssistantMessage(
        fauxToolCall("bash", {
          command: [
            "printf 'effect\\n' >> effects.txt",
            "printf '%s\\n' \"$$\" > tool.pid",
            "printf 'tool-checkpoint:%s\\n' \"$$\"",
            "kill -STOP \"$$\"",
          ].join("; "),
          timeout: 20,
        } satisfies BashToolInput, { id: "unsafe-append" }),
        { stopReason: "toolUse" },
      )]);
  const owner = await CodingWorkspaceOwner.open(runtime.options, context);
  const deadline = setTimeout(() => disconnected.resolve(), 25_000);
  try {
    const provider = await owner.harness.snapshot(ProviderDoc, owner.conversation.id, context);
    assert.ok(provider);
    if (kind === "generation") {
      const submission = await owner.conversation.submit({
        type: "input",
        content: "Complete after the process restarts.",
        requestId: "restart-generation",
      }, context);
      await awaitWithContext(requested.promise, context);
      const inspection = await owner.harness.inspect(context);
      const task = inspection.tasks.find(
        (item) => item.record.kind === GenerationTask.definition.name,
      )?.record;
      assert.ok(task && task.state.status === "running");
      const checkpoint = task.state.checkpoint;
      assert.ok(typeof checkpoint === "object" && checkpoint !== null && "phase" in checkpoint);
      assert.equal(checkpoint.phase, "request");
      await sendCheckpoint({
        kind,
        phase: "request",
        rootId: owner.conversation.id,
        providerSessionId: provider.sessionId,
        submissionId: submission.id,
        taskId: task.id,
      });
    } else {
      const watch = await owner.harness.watchDoc(LiveDoc, owner.conversation.id, context);
      assert.ok(watch);
      const ready = Promise.withResolvers<{ taskId: TaskId; toolPid: number }>();
      watch.start(async (value) => {
        const slot = value?.tools?.find((tool) => tool.callId === "unsafe-append");
        const match = /^tool-checkpoint:(\d+)\n$/.exec(slot?.output ?? "");
        if (slot?.taskId !== undefined && match?.[1] !== undefined)
          ready.resolve({ taskId: slot.taskId, toolPid: Number(match[1]) });
      });
      try {
        const submission = await owner.conversation.submit({
          type: "input",
          content: "Append one effect and wait for interruption.",
          requestId: "restart-tool",
        }, context);
        const progress = await awaitWithContext(ready.promise, context);
        assert.ok(Number.isSafeInteger(progress.toolPid) && progress.toolPid > 1);
        const task = await owner.harness.getTask(progress.taskId, context);
        assert.ok(
          task && task.kind === ToolTask.definition.name && task.state.status === "running",
        );
        const checkpoint = task.state.checkpoint;
        assert.ok(
          typeof checkpoint === "object" && checkpoint !== null &&
          "phase" in checkpoint && "replay" in checkpoint,
        );
        assert.equal(checkpoint.phase, "execute");
        assert.equal(checkpoint.replay, "unsafe");
        await sendCheckpoint({
          kind,
          phase: "execute",
          replay: "unsafe",
          rootId: owner.conversation.id,
          providerSessionId: provider.sessionId,
          submissionId: submission.id,
          taskId: task.id,
          toolPid: progress.toolPid,
        });
      } finally {
        await watch.stop();
      }
    }
    await awaitWithContext(disconnected.promise, context);
  } finally {
    clearTimeout(deadline);
    await owner.close();
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "worker") {
  const kind = process.argv[3];
  const root = process.argv[4];
  assert.ok(kind === "generation" || kind === "unsafe-tool");
  assert.ok(root);
  await restartWorker(kind, root);
}
