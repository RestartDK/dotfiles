import assert from "node:assert/strict";
import {
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "../config/pi/agent/extensions/pi-herdr/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { AuthStorage } from "../config/pi/agent/extensions/pi-herdr/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { loadExtensionFromFactory } from "../config/pi/agent/extensions/pi-herdr/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import registerHerdr from "../config/pi/agent/extensions/pi-herdr/index.ts";

export async function herdrRuntime() {
  assert.equal(process.env.HERDR_ENV, "1", "Run inside Herdr");
  const host = createExtensionRuntime();
  const registry = new ModelRegistry(
    await ModelRuntime.create({
      credentials: AuthStorage.inMemory(),
      modelsPath: null,
      refreshOnCreate: false,
    }),
  );
  const extension = await loadExtensionFromFactory(
    registerHerdr,
    process.cwd(),
    createEventBus(),
    host,
  );
  const runner = new ExtensionRunner(
    [extension],
    host,
    process.cwd(),
    SessionManager.inMemory(),
    registry,
  );
  const tool = runner.getToolDefinition("herdr");
  assert.ok(tool);
  return {
    call: (params: Parameters<typeof tool.execute>[1], signal?: AbortSignal) =>
      tool.execute(
        "runtime-proof",
        params,
        signal,
        undefined,
        runner.createToolContext("runtime-proof", signal),
      ),
    close: () => runner.emit({ type: "session_shutdown", reason: "quit" }),
  };
}

if (process.argv[1] === import.meta.filename) {
  const [pane, command, timeout = "120000"] = process.argv.slice(2);
  assert.ok(
    pane && command,
    "Usage: node --experimental-strip-types tests/herdr-runtime.ts PANE COMMAND",
  );
  const runtime = await herdrRuntime();
  try {
    const result = await runtime.call({
      action: "run",
      pane,
      command,
      wait: true,
      timeout: Number(timeout),
    });
    console.log(JSON.stringify(result, null, 2));
    const details = result.details;
    assert.ok(
      details && typeof details === "object" && "state" in details && details.state === "done",
      "Command did not return to an idle shell",
    );
    assert.ok("exitCode" in details && typeof details.exitCode === "number", "No exit code");
    process.exitCode = details.exitCode;
  } finally {
    await runtime.close();
  }
}
