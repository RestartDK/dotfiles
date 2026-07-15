import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piIndex from "./index.ts";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details: {
    language: string;
    sourceLines: number;
    itemCount: number;
    cacheHit: boolean;
  };
}

interface RegisteredTool {
  execute(
    toolCallId: string,
    params: { path: string; language?: string },
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: { cwd: string },
  ): Promise<ToolResult>;
}

interface RegisteredCommand {
  handler(args: string, ctx: { ui: { notify(message: string, level: string): void } }): Promise<void>;
}

test("registers and executes the index tool with mtime caching", async () => {
  let registered: RegisteredTool | undefined;
  let indexMode: RegisteredCommand | undefined;
  let activeTools = ["read", "index"];
  const fakePi = {
    registerTool(tool: unknown) {
      registered = tool as RegisteredTool;
    },
    registerCommand(name: string, command: unknown) {
      if (name === "index-mode") indexMode = command as RegisteredCommand;
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
  } as unknown as ExtensionAPI;

  piIndex(fakePi);
  assert.ok(registered, "index tool was not registered");
  assert.ok(indexMode, "index-mode command was not registered");

  const directory = await mkdtemp(join(tmpdir(), "pi-index-test-"));
  try {
    const path = join(directory, "sample.ts");
    await writeFile(path, "export function answer(): number { return 42; }\n", "utf8");

    const first = await registered.execute("call-1", { path }, undefined, undefined, { cwd: directory });
    assert.equal(first.details.language, "typescript");
    assert.equal(first.details.cacheHit, false);
    assert.ok(first.details.itemCount > 0);
    assert.match(first.content[0]?.text ?? "", /function answer\(\): number.*\[1\]/);

    const second = await registered.execute("call-2", { path }, undefined, undefined, { cwd: directory });
    assert.equal(second.details.cacheHit, true);

    const notifications: string[] = [];
    const commandContext = {
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    };
    await indexMode.handler("off", commandContext);
    assert.equal(activeTools.includes("index"), false);
    assert.match(notifications.at(-1) ?? "", /Index mode is off/);

    await indexMode.handler("on", commandContext);
    assert.equal(activeTools.includes("index"), true);
    assert.match(notifications.at(-1) ?? "", /Index mode is on/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
