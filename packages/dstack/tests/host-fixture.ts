import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { DurableHost } from "#durable-host";
import { serveHost } from "#host-stdio";
import { loadHostConfig } from "#host-protocol";
import { hostCommandRuntime } from "../src/host-runtime.js";

const path = process.argv[2];
assert.ok(path);
process.umask(0o077);
const config = await loadHostConfig({
  path,
  expectedSha256: process.env.HERDR_DURABLE_HOST_CONFIG_SHA256,
});
const faux = fauxProvider({
  api: "host-fixture",
  provider: "host-fixture",
  models: [{ id: "files", input: ["text"] }],
  tokenSize: { min: 4096, max: 4096 },
});
const mode = process.argv[3];
if (mode === "admission-crash" || mode === "ack-crash") {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    const run = statement.run.bind(statement);
    if (
      (mode === "admission-crash" && sql.startsWith("INSERT INTO admissions")) ||
      (mode === "ack-crash" && sql.startsWith("UPDATE admissions"))
    ) {
      statement.run = (...parameters) => {
        const values = parameters.map((parameter) => {
          if (typeof parameter === "object" && parameter !== null && !ArrayBuffer.isView(parameter))
            throw new Error("Crash fixture requires positional SQLite parameters");
          return parameter;
        });
        const result = run(...values);
        if (parameters.some((parameter) => parameter === mode))
          process.kill(process.pid, "SIGKILL");
        return result;
      };
    }
    return statement;
  };
}
if (mode === "create-crash") {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    exec.call(this, sql);
    if (
      sql === "COMMIT" &&
      this.prepare("SELECT name FROM sqlite_master WHERE name='admissions'").get() !== undefined &&
      this.prepare("SELECT id FROM admissions WHERE id='create-crash'").get() !== undefined
    )
      process.kill(process.pid, "SIGKILL");
  };
}
faux.setResponses(
  mode === "join"
    ? [
        async (_transcript, options) => {
          assert.ok(options?.signal);
          await writeFile(join(config.stateRoot, "model-started"), "started");
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) resolve();
            else options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          await writeFile(join(config.stateRoot, "model-joined"), "joined");
          return fauxAssistantMessage("", { stopReason: "aborted" });
        },
      ]
    : [
        (transcript) => {
          assert.deepEqual(
            transcript.messages
              .flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []))
              .map((tool) => tool.name)
              .sort(),
            ["edit", "read", "write"],
          );
          return fauxAssistantMessage(
            fauxToolCall("write", { path: "proof.txt", content: "host-owned\n" }),
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage("File persisted."),
      ],
);
const models = createModels();
models.setProvider(faux.provider);
const commands = mode === "commands" ? await hostCommandRuntime() : undefined;
await serveHost(await DurableHost.open(config, models, commands === undefined ? {} : { commands }), process.stdin, process.stdout);
