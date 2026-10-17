import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import jobsExtension from "../../../config/pi/agent/extensions/pi-jobs/index.ts";
import {
  callWatches,
  parseWatchRequest,
  type WatchView,
} from "../../../config/pi/agent/lib/dstack-watches.ts";
import { record } from "../../../config/pi/agent/lib/dstack-jobs.ts";

const root = await mkdtemp("/tmp/dwp-");
const socket = join(root, "state/jobs.sock");
const proxySocket = join(root, "receiver.sock");
const previousSocket = process.env.DSTACK_SOCKET;
process.env.DSTACK_SOCKET = proxySocket;
const log: string[] = [];
let child: ChildProcess | undefined;
let exited: Promise<void> | undefined;
let session: AgentSession | undefined;
let requests = 0;
let ackAttempts = 0;
const acknowledged = Promise.withResolvers<void>();
const manager = SessionManager.create(root, root);
const model: Model<"openai-responses"> = {
  api: "openai-responses",
  provider: "wake-fixture",
  id: "wake-fixture",
  name: "Deterministic wake fixture",
  baseUrl: "https://invalid.example",
  reasoning: false,
  input: ["text"],
  contextWindow: 100000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function provider(pi: ExtensionAPI) {
  pi.registerProvider(model.provider, {
    api: model.api,
    apiKey: "fixture-not-a-secret",
    models: [model],
    streamSimple: () => {
      requests++;
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (requests === 1) {
          const args = {
            op: "create",
            trigger: { kind: "timer", at: Date.now() + 4000 },
            deadline: Date.now() + 60_000,
            message: "Resume this exact native session once",
          };
          const call = {
            type: "toolCall",
            id: "proof-timer",
            name: "dstack_wake",
            arguments: args,
          } satisfies AssistantMessage["content"][number];
          message.content.push(call);
          message.stopReason = "toolUse";
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({
            type: "toolcall_delta",
            contentIndex: 0,
            delta: JSON.stringify(args),
            partial: message,
          });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        } else {
          const text = requests === 2 ? "Timer registered. Idle now." : "Native wake received.";
          message.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        }
        stream.push({ type: "done", reason: requests === 1 ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    },
  });
}
async function startDaemon() {
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../tests/wake-daemon.mjs", import.meta.url))],
    {
      env: { ...process.env, DSTACK_WAKE_FIXTURE: root },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  child.stdout?.on("data", (chunk) => log.push(String(chunk)));
  child.stderr?.on("data", (chunk) => log.push(String(chunk)));
  const current = child;
  exited = new Promise((resolve, reject) => {
    current.once("error", reject);
    current.once("exit", (code, signal) =>
      code === 0 || signal === "SIGKILL" ? resolve() : reject(new Error(log.join(""))),
    );
  });
  await new Promise<void>((resolve, reject) => {
    current.once("message", () => resolve());
    current.once("exit", () => reject(new Error(log.join(""))));
  });
}
async function stopDaemon(crash = false) {
  if (!child) return;
  child.kill(crash ? "SIGKILL" : "SIGTERM");
  await exited;
  child = undefined;
}
const proxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (req.url === "/v1/jobs") {
      res.end(JSON.stringify({ version: 1, now: Date.now(), jobs: [] }));
      return;
    }
    const input = parseWatchRequest(parsed);
    if (input.op === "ack") {
      ackAttempts++;
      const receipt = manager.getEntries().find((e) => e.id === input.entryId);
      assert.equal(receipt?.type, "custom_message");
      assert.equal(
        receipt && "customType" in receipt ? receipt.customType : undefined,
        "dstack-wake",
      );
      const file = manager.getSessionFile();
      assert.ok(file);
      const persisted = (await readFile(file, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => record(JSON.parse(line)));
      assert.ok(
        persisted.some(
          (e) =>
            e.id === input.entryId &&
            e.type === "custom_message" &&
            record(e.details).token === input.token,
        ),
      );
      log.push(`ack ${ackAttempts} verified persisted receipt ${input.entryId}\n`);
      if (ackAttempts === 1) {
        res
          .writeHead(503)
          .end(JSON.stringify({ error: "Fixture drops the first acknowledgement before commit" }));
        return;
      }
    }
    const result = await callWatches(input, { socket });
    res.end(JSON.stringify(result));
    if (input.op === "ack") acknowledged.resolve();
  } catch (error) {
    res
      .writeHead(400)
      .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    if (error instanceof Error && error.name === "AssertionError") acknowledged.reject(error);
  }
});
const deadline = setTimeout(
  () => acknowledged.reject(new Error("Native proof deadline exceeded")),
  30_000,
);
try {
  await startDaemon();
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(proxySocket, resolve);
  });
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: model.provider,
    defaultModel: model.id,
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [provider, jobsExtension],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  ({ session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model,
    thinkingLevel: "off",
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    noTools: "builtin",
  }));
  await session.bindExtensions({
    mode: "json",
    onError: (error) => acknowledged.reject(new Error(error.error)),
  });
  await session.prompt("Register the fixture timer, then become idle.");
  assert.equal(requests, 2);
  const pending = (await callWatches({ op: "list", sessionId: manager.getSessionId() }, { socket }))
    .watches[0];
  assert.ok(pending);
  assert.equal(pending.state.kind, "watching");
  log.push(`Native tool admitted ${pending.id}; session idle; restarting daemon\n`);
  await stopDaemon(true);
  await startDaemon();
  await acknowledged.promise;
  await session.waitForIdle();
  const delivered: WatchView | undefined = (
    await callWatches({ op: "status", id: pending.id }, { socket })
  ).watches[0];
  assert.equal(delivered?.state.kind, "delivered");
  assert.equal(requests, 3);
  assert.equal(ackAttempts, 2);
  assert.equal(
    manager
      .getEntries()
      .filter((e) => e.type === "custom_message" && e.customType === "dstack-wake").length,
    1,
  );
  log.push(
    "PASS native tool admission, idle wake, daemon restart, persisted receipt before ack, lost-ack retry, one wake turn; zero paid calls\n",
  );
  console.log(log.join(""));
} finally {
  clearTimeout(deadline);
  if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session?.dispose();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await stopDaemon();
  if (previousSocket === undefined) delete process.env.DSTACK_SOCKET;
  else process.env.DSTACK_SOCKET = previousSocket;
  await writeFile(join(root, "proof.log"), log.join(""));
  console.log(`Retained native proof artifacts: ${root}`);
}
