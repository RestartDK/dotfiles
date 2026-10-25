import { readFile } from "node:fs/promises";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { DurableHost, type TrustedHostCommandOperation } from "#durable-host";
import { parseHostConfig, parseOperation } from "#host-protocol";
import { hostCommandRuntime } from "../src/host-runtime.js";

const configPath = process.argv[2];
if (configPath === undefined || process.send === undefined) throw new Error("Owned proof fixture requires private config and IPC");
const models = createModels();
models.setProvider(fauxProvider({ api: "host-command-fixture", provider: "host-command-fixture", models: [{ id: "idle", input: ["text"] }] }).provider);
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
  })().then(value => process.send?.({ id, value }), () => process.send?.({ id, error: "Trusted fixture request refused" }));
});
