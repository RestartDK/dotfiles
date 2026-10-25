import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseCommandSpec } from "#command-wire";

const node = process.env.DSTACK_TEST_NODE, systemctl = process.env.DSTACK_SYSTEMCTL;
assert.ok(node !== undefined && node.startsWith("/nix/store/"), "Explicit production Node required");
assert.ok(systemctl !== undefined && systemctl.startsWith("/nix/store/") && process.env.XDG_RUNTIME_DIR, "Original user-manager context required");
const audit = join(await realpath(process.cwd()), ".audit"); await mkdir(audit, { recursive: true, mode: 0o700 });
const path = await mkdtemp(join(audit, "host-controls-")), cwd = join(path, "workspace"), stateRoot = join(path, "state"), config = join(path, "config.json");
await mkdir(cwd, { mode: 0o700 });
await writeFile(config, JSON.stringify({ identity: { deploymentId: "command-controls-proof", domain: "personal", nodeId: "fixture" }, stateRoot, model: { provider: "host-command-fixture", modelId: "idle" }, thinkingLevel: "off", authPath: join(path, "auth.json"), modelsPath: join(path, "models.json"), execution: { mode: "durable", maxRecords: 128 } }), { flag: "wx", mode: 0o600 });
function object(value: unknown): Record<string, unknown> { assert.ok(typeof value === "object" && value !== null && !Array.isArray(value)); return Object.fromEntries(Object.entries(value)); }
const child = fork(fileURLToPath(new URL("./host-command-fixture.js", import.meta.url)), [config, "command-controls"], { execPath: node, stdio: ["ignore", "ignore", "pipe", "ipc"] });
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; deadline: NodeJS.Timeout }>();
let next = 0, stderr = "";
child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 32768) stderr += chunk.toString(); });
const exit = new Promise<{ kind: "exited"; code: number | null; signal: NodeJS.Signals | null } | { kind: "spawn-error"; error: Error }>(resolve => {
  child.once("error", error => resolve({ kind: "spawn-error", error }));
  child.once("exit", (code, signal) => {
    for (const request of pending.values()) { clearTimeout(request.deadline); request.reject(new Error(`Control backend exited ${code}/${signal}: ${stderr}`)); }
    pending.clear(); resolve({ kind: "exited", code, signal });
  });
});
const ready = new Promise<void>((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error("Control backend readiness deadline")), 15000);
  child.once("error", error => { clearTimeout(deadline); reject(error); });
  child.once("exit", () => { clearTimeout(deadline); reject(new Error(`Control backend exited before readiness: ${stderr}`)); });
  child.on("message", (value: unknown) => {
    const message = object(value);
    if (message.event === "ready") { clearTimeout(deadline); resolve(); }
    else if (typeof message.id === "number") {
      const request = pending.get(message.id);
      if (request !== undefined) {
        clearTimeout(request.deadline); pending.delete(message.id);
        if ("error" in message) request.reject(new Error("Trusted control fixture refused request", { cause: message.code })); else request.resolve(message.value);
      }
    }
  });
});
function call(request: object): Promise<unknown> {
  const id = ++next;
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { pending.delete(id); reject(new Error("Control request deadline")); }, 15000);
    pending.set(id, { resolve, reject, deadline }); child.send({ id, ...request });
  });
}
const operation = (value: object) => call({ operation: { workspaceId: "coding", ...value } });
const command = (op: "start" | "describe" | "inspect" | "adopt" | "cancel" | "release") => call({ command: { op, workspaceId: "coding", intentId: "cancel" } });
async function until<T>(action: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 12000;
  while (performance.now() < deadline) { const value = await action(); if (value !== undefined) return value; await delay(20); }
  throw new Error("Control proof observation deadline");
}
function events() {
  const database = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  try { return database.prepare("SELECT record_json FROM herdr_execution_records ORDER BY sequence").all().map(row => object(object(JSON.parse(String(row.record_json))).event)); }
  finally { database.close(); }
}
let custody: "none" | "owned" | "released" = "none";
const failures: unknown[] = [];
try {
  await ready;
  await operation({ op: "create", requestId: "create", cwd });
  for (const requestId of ["seed-first", "seed-second"]) {
    await operation({ op: "submit", requestId, content: requestId });
    await until(async () => { const response = object(await operation({ op: "status", requestId })); return response.receipt !== null && object(response.receipt).status === "done" ? true : undefined; });
  }
  assert.equal(object(await call({ tasks: true })).providerCalls, 2, "Two completed turns give manual compaction a real prefix");
  const marker = join(cwd, "ready.txt");
  const authorized = object(await call({ command: { op: "authorize", workspaceId: "coding", authorization: { intentId: "cancel", argv: [node, "-e", "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],'ready\\n',{flag:'wx'});setInterval(()=>{},1000)", marker], timeoutSeconds: 15 } } }));
  custody = "owned";
  assert.ok(typeof object(authorized.authorization).specJson === "string");
  const spec = parseCommandSpec(String(object(authorized.authorization).specJson)), sdk = object(await command("start"));
  await until(async () => { try { return await readFile(marker, "utf8"); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined; throw error; } });
  const before = object(await command("inspect")); assert.equal(object(before.outcome).kind, "unobserved"); assert.equal(object(before.containment).kind, "active");
  await assert.rejects(operation({ op: "submit", requestId: "blocked", content: "must not infer" }), error => error instanceof Error && error.cause === "effect_unresolved");
  await operation({ op: "snapshot" });
  const compact = object(await call({ compact: true })); assert.ok(typeof compact.taskKey === "string");
  const compactTask = await until(async () => {
    const inspection = object(await call({ tasks: true })); assert.equal(inspection.providerCalls, 2);
    assert.ok(Array.isArray(inspection.tasks));
    const task = inspection.tasks.map(object).find(task => String(task.id) === compact.taskKey);
    return task !== undefined && object(task.state).status === "terminal" ? task : undefined;
  });
  assert.equal(compactTask.kind, "pi.compaction"); assert.equal(object(object(compactTask.state).outcome).status, "faulted");
  assert.match(JSON.stringify(compactTask), /Unresolved execution effects block workspace progress/);
  const statusBefore = object(await command("describe")), aborted = object(await call({ abort: true }));
  assert.equal(aborted.providerCalls, 2); assert.deepEqual(await command("describe"), statusBefore);
  assert.equal(object(object(await command("inspect")).containment).kind, "active", "SDK abort must not implicitly cancel the separate command");
  await command("cancel");
  let repeatedCancellation: "signal-confirmed" | "request-refused" = "signal-confirmed";
  try { await command("cancel"); } catch (error) { assert.ok(error instanceof Error && error.cause === "fixture_error"); repeatedCancellation = "request-refused"; }
  const observation = await until(async () => { const value = object(await command("inspect")); return object(value.outcome).kind === "recorded" && object(value.containment).kind === "empty" ? value : undefined; });
  const outcome = object(object(object(observation.outcome).receipt).outcome); assert.equal(outcome.kind, "signal"); assert.equal(outcome.cause, "cancelled");
  assert.equal(object(object(await command("adopt")).phase).kind, "adopted");
  assert.equal(object(object(await command("cancel")).phase).kind, "adopted", "Terminal cancellation must converge without another attempt");
  await command("release"); custody = "released";
  const released = spawnSync(systemctl, ["--user", "show", spec.unit, "--property=NFileDescriptorStore"], { encoding: "utf8" }); assert.match(released.stdout, /^NFileDescriptorStore=0$/m);
  const journal = events();
  assert.equal(journal.filter(event => event.kind === "command.attempted").length, 1); assert.equal(journal.filter(event => event.kind === "command.cancel-requested").length, 1); assert.equal(journal.filter(event => event.kind === "command.adopted").length, 1);
  const attempted = journal.find(event => event.kind === "command.attempted"); assert.ok(attempted !== undefined);
  assert.deepEqual(attempted.sdk, { kind: "task", taskKey: sdk.taskKey, conversationKey: sdk.conversationKey });
  assert.equal(object(await call({ tasks: true })).providerCalls, 2);
  const result = { proof: "actual-host-sdk-command-controls", path, sdk, compactTaskKey: compact.taskKey, repeatedCancellation, realCompactionFaultedBeforeInference: true, submissionBlockedWhileSnapshotReadable: true, sdkAbortDidNotCancelCommand: true, originalCancelledReceiptAndEmptyContainment: true, oneAttemptAndCancellationRecord: true, originalCustodyReleased: true };
  await writeFile(join(path, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(result));
} catch (error) { failures.push(error); }
if (custody === "owned") {
  try {
    const status = object(await command("describe"));
    if (object(object(status.command).phase).kind === "authorized") await command("cancel");
    else {
      await command("cancel").catch(() => undefined);
      const observation = object(await command("inspect"));
      if (object(observation.outcome).kind !== "recorded" || object(observation.containment).kind !== "empty") throw new Error("Original command containment remains uncertain");
      assert.equal(object(object(await command("adopt")).phase).kind, "adopted"); await command("release");
    }
  } catch (error) { failures.push(error); }
}
if (child.connected) child.disconnect();
const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
try { const status = await exit; if (status.kind === "spawn-error") throw status.error; assert.equal(status.code, 0, stderr); }
catch (error) { failures.push(error); } finally { clearTimeout(deadline); }
if (failures.length) throw new AggregateError(failures, `Command controls proof failed; preserve ${path}`);
