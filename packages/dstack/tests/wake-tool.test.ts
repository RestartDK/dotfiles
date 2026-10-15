import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import {
  nativeWatchRequest,
  watchToolResult,
} from "../../../config/pi/agent/extensions/pi-jobs/wake-tool.ts";
import { jobToolResult, modelContext } from "../../../config/pi/agent/extensions/pi-jobs/view.ts";
import { watchLine, type WatchView } from "../../../config/pi/agent/lib/dstack-watches.ts";
import {
  array,
  record,
  string,
  type Connection,
  type Snapshot,
} from "../../../config/pi/agent/lib/dstack-jobs.ts";

const params = {
  op: "create",
  trigger: { kind: "timer", at: 100 },
  deadline: 200,
  message: "Continue",
} satisfies Parameters<typeof nativeWatchRequest>[1];
function assistant(session: SessionManager) {
  return session.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call_0", name: "dstack_wake", arguments: params }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    stopReason: "toolUse",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
}

test("native request identity survives retries without colliding across turns or sessions", () => {
  const root = mkdtempSync("/tmp/dwtool-");
  const session = SessionManager.create(root, root);
  assistant(session);
  const first = nativeWatchRequest("call_0", params, session);
  expect(nativeWatchRequest("call_0", params, session)).toEqual(first);
  const other = nativeWatchRequest("call_0", params, {
    getSessionId: () => "another-native-session",
    getSessionFile: () => session.getSessionFile(),
    getBranch: () => session.getBranch(),
  });
  expect(other).not.toEqual(first);
  assistant(session);
  expect(nativeWatchRequest("call_0", params, session)).not.toEqual(first);
  expect(() => nativeWatchRequest("call_0", params, SessionManager.inMemory())).toThrow(
    "persistent",
  );
  expect(() => nativeWatchRequest("call_0", params, SessionManager.create(root, root))).toThrow(
    "origin",
  );
});

test("model lists and passive views prioritize live wakes over retained history and bound output", () => {
  const base: WatchView = {
    id: "0".repeat(24),
    requestId: "request",
    sessionId: "native",
    trigger: { kind: "timer", at: 100 },
    deadline: 200,
    message: "Wake",
    createdAt: 0,
    updatedAt: 0,
    state: {
      kind: "delivered",
      result: { kind: "timer", at: 100 },
      token: "token",
      entryId: "entry",
    },
  };
  const watches: WatchView[] = Array.from({ length: 1000 }, (_, i) => ({
    ...base,
    id: i.toString(16).padStart(24, "0"),
    updatedAt: i,
  }));
  const pending = watches[0];
  const delivering = watches[1];
  const watching = watches[2];
  if (!pending || !delivering || !watching) throw new Error("Missing fixtures");
  pending.state = { kind: "pending", result: { kind: "timer", at: 100 } };
  delivering.state = {
    kind: "delivering",
    result: { kind: "timer", at: 100 },
    token: "token",
    startedAt: 100,
  };
  watching.state = { kind: "watching", nextAt: 200, observations: 0, error: null };
  const result = watchToolResult({ version: 1, now: 100, watches });
  expect(result.watches).toHaveLength(64);
  expect(result.omitted).toBe(936);
  expect(result.watches.slice(0, 3).map((w) => w.id)).toEqual([
    delivering.id,
    pending.id,
    watching.id,
  ]);
  const connection = {
    kind: "online",
    snapshot: { version: 1, now: 100, jobs: [], watches },
    receivedAt: 100,
  } satisfies Connection;
  expect(watchLine(delivering)).toContain("receipt missing");
  const context = record(JSON.parse(modelContext(connection, 100, "native") ?? "null"));
  expect(
    array(context.watches)
      .slice(0, 3)
      .map((value) => string(record(value).id)),
  ).toEqual([delivering.id, pending.id, watching.id]);
});

test("registered jobs tool excludes every session's watches from text, details and structured output", async () => {
  const root = mkdtempSync("/tmp/dwtool-");
  const socket = join(root, "jobs.sock");
  const previousSocket = process.env.DSTACK_SOCKET;
  const snapshot: Snapshot = {
    version: 1,
    now: 100,
    jobs: [],
    watches: Array.from(
      { length: 1000 },
      (_, i): WatchView => ({
        id: i.toString(16).padStart(24, "0"),
        requestId: `request-${i}`,
        sessionId: `other-session-${i}`,
        trigger: { kind: "timer", at: 100 },
        deadline: 200,
        message: "private".repeat(500),
        createdAt: 0,
        updatedAt: 100,
        state: { kind: "pending", result: { kind: "timer", at: 100 } },
      }),
    ),
  };
  const server = createServer((req, res) => {
    req.resume();
    res.end(JSON.stringify(snapshot));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    process.env.DSTACK_SOCKET = socket;
    const host = createExtensionRuntime();
    const loaded = await loadExtensions(
      [
        fileURLToPath(
          new URL("../../../config/pi/agent/extensions/pi-jobs/index.ts", import.meta.url),
        ),
      ],
      root,
      createEventBus(),
      host,
    );
    expect(loaded.errors).toEqual([]);
    const registry = new ModelRegistry(
      await ModelRuntime.create({
        credentials: AuthStorage.inMemory(),
        modelsPath: null,
        refreshOnCreate: false,
      }),
    );
    const runner = new ExtensionRunner(
      loaded.extensions,
      host,
      root,
      SessionManager.inMemory(),
      registry,
    );
    const tool = runner.getToolDefinition("dstack_jobs");
    if (!tool) throw new Error("Jobs tool was not registered");
    const result = await tool.execute(
      "list-call",
      { op: "list" },
      undefined,
      undefined,
      runner.createToolContext("list-call", undefined),
    );
    expect(result).toEqual(jobToolResult(snapshot));
    const expected = { version: 1, now: 100, jobs: [] };
    expect(result.details).toEqual(expected);
    expect(result.structuredContent).toEqual(expected);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
  } finally {
    if (previousSocket === undefined) delete process.env.DSTACK_SOCKET;
    else process.env.DSTACK_SOCKET = previousSocket;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
