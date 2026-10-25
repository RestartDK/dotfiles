import { readFile } from "node:fs/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DurableHost, type TrustedHostCommandOperation } from "#durable-host";
import { parseHostConfig, parseOperation } from "#host-protocol";
import { hostCommandRuntime } from "../src/host-runtime.js";

const configPath = process.argv[2];
if (configPath === undefined || process.send === undefined) throw new Error("Owned proof fixture requires private config and IPC");
const models = createModels();
const faux = fauxProvider({ api: "host-command-fixture", provider: "host-command-fixture", models: [{ id: "idle", input: ["text"] }] });
models.setProvider(faux.provider);
if (process.argv[3] === "file-hold") {
  const heldPath = process.argv[4];
  if (heldPath === undefined) throw new Error("Explicit held file required");
  faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: heldPath, content: "must not replay\n" }), { stopReason: "toolUse" })]);
  const write = NodeExecutionEnv.prototype.writeFile;
  NodeExecutionEnv.prototype.writeFile = async function (this: NodeExecutionEnv, ...args: Parameters<NodeExecutionEnv["writeFile"]>) {
    if (args[0] === heldPath) {
      process.send?.({ event: "file-held", path: args[0] });
      await new Promise<void>(() => undefined);
    }
    return write.apply(this, args);
  };
}
const config = parseHostConfig(JSON.parse(await readFile(configPath, "utf8")));
const commands = await hostCommandRuntime();
if (process.argv[3] === "hold-launch") {
  const launch = commands.runtime.launch.bind(commands.runtime);
  commands.runtime.launch = async input => {
    const evidence = await launch(input);
    process.send?.({ event: "launch-held", executionId: input.spec.executionId });
    await new Promise<void>(() => undefined);
    return evidence;
  };
}
const openHarness = Harness.open;
let inspectTasks: (() => Promise<unknown>) | undefined;
let abortConversation: (() => Promise<void>) | undefined;
Harness.open = async (storage, options, context) => {
  const harness = await openHarness(storage, options, context);
  inspectTasks = async () => ({ inspection: await harness.inspect(BACKGROUND_CONTEXT), tasks: (await storage.scanTasks({}, 128, undefined, BACKGROUND_CONTEXT)).items, providerCalls: faux.state.callCount });
  abortConversation = async () => {
    const conversations = await storage.scanConversations({}, 2, undefined, BACKGROUND_CONTEXT);
    if (conversations.items.length !== 1 || conversations.items[0] === undefined) throw new Error("One actual SDK conversation expected");
    const conversation = await harness.conversation(conversations.items[0].id, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error("Actual SDK conversation missing");
    await conversation.abort(BACKGROUND_CONTEXT);
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
  };
  if (process.argv[3] === "hold-scheduler") harness.resume = () => undefined;
  return harness;
};
const host = await DurableHost.open(config, models, { commands, protectedPaths: [configPath] });
process.send({ event: "ready" });
let closing: Promise<void> | undefined;
const close = () => closing ??= host.close();
process.on("disconnect", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
process.on("message", (message: unknown) => {
  if (typeof message !== "object" || message === null || !("id" in message)) return;
  const id = message.id;
  void (async () => {
    if ("operation" in message) return host.handle(parseOperation(message.operation));
    if ("tasks" in message && message.tasks === true) {
      if (inspectTasks === undefined) throw new Error("SDK workspace unavailable");
      return inspectTasks();
    }
    if ("abort" in message && message.abort === true) {
      if (abortConversation === undefined) throw new Error("SDK conversation unavailable");
      await abortConversation();
      return { providerCalls: faux.state.callCount };
    }
    if ("command" in message) {
      const command: unknown = message.command;
      if (typeof command !== "object" || command === null || !("op" in command) || typeof command.op !== "string" || !("workspaceId" in command) || typeof command.workspaceId !== "string")
        throw new Error("Invalid trusted fixture command");
      switch (command.op) {
        case "authorize": {
          if (!("authorization" in command) || typeof command.authorization !== "object" || command.authorization === null) throw new Error("Invalid fixture authorization");
          const authorization = command.authorization;
          if (!("intentId" in authorization) || typeof authorization.intentId !== "string" || !("argv" in authorization) || !Array.isArray(authorization.argv) || !authorization.argv.every((value: unknown): value is string => typeof value === "string") || !("timeoutSeconds" in authorization) || typeof authorization.timeoutSeconds !== "number")
            throw new Error("Invalid fixture authorization");
          return host.command({ op: command.op, workspaceId: command.workspaceId, authorization: { intentId: authorization.intentId, argv: authorization.argv, timeoutSeconds: authorization.timeoutSeconds } });
        }
        case "start": case "describe": case "inspect": case "adopt": case "cancel": case "release":
          if (!("intentId" in command) || typeof command.intentId !== "string") throw new Error("Invalid fixture intent");
          return host.command({ op: command.op, workspaceId: command.workspaceId, intentId: command.intentId } satisfies TrustedHostCommandOperation);
        default: throw new Error("Unsupported fixture command");
      }
    }
    throw new Error("Invalid fixture request");
  })().then(value => process.send?.({ id, value }), (error: unknown) => process.send?.({ id, error: "Trusted fixture request refused", code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "fixture_error" }));
});
