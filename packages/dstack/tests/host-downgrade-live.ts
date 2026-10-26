import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

function packagedReference(name: string): string {
  const value = process.env[name]; assert.ok(typeof value === "string" && value.startsWith("/nix/store/")); return value;
}
const node = packagedReference("DSTACK_TEST_NODE"), old = packagedReference("DSTACK_OLD_FIXTURE");
assert.equal(process.getuid?.(), 1000);
const modern = fileURLToPath(new URL("./host-fixture.js", import.meta.url));
await access(old); await access(modern);
const path = await mkdtemp(join(tmpdir(), "host-downgrade-")), cwd = join(path, "workspace"), stateRoot = join(path, "state"), file = join(cwd, "proof.txt");
await mkdir(cwd, { mode: 0o700 }); await writeFile(file, "preserved\n", { flag: "wx", mode: 0o400 });
const common = { identity: { deploymentId: "downgrade-proof", domain: "personal", nodeId: "fixture" }, stateRoot, model: { provider: "host-fixture", modelId: "files" }, thinkingLevel: "off", authPath: join(path, "unused-auth.json"), modelsPath: join(path, "unused-models.json") };
const enabled = join(path, "enabled.json"), disabled = join(path, "disabled.json");
await writeFile(enabled, JSON.stringify({ ...common, execution: { mode: "durable", maxRecords: 256 } }), { flag: "wx", mode: 0o600 });
await writeFile(disabled, JSON.stringify(common), { flag: "wx", mode: 0o600 });
function object(value: unknown): Record<string, unknown> { assert.ok(typeof value === "object" && value !== null && !Array.isArray(value)); return Object.fromEntries(Object.entries(value)); }
type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly errors: string; readonly timedOut: boolean };
type Boot = { readonly kind: "ready"; readonly frame: Record<string, unknown> } | { readonly kind: "refused"; readonly exit: Exit };
function start(executable: string, config: string) {
  const child = spawn(node, [executable, config], { stdio: ["pipe", "pipe", "pipe"] });
  let errors = "", timedOut = false, id = 0;
  child.stderr.on("data", (chunk: Buffer) => { if (errors.length < 32768) errors += chunk.toString(); });
  const exit = new Promise<Exit>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, errors, timedOut })); });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20000);
  void exit.then(() => clearTimeout(timer), () => clearTimeout(timer));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  return {
    child, exit,
    async ready(): Promise<Boot> {
      const line = await lines.next(); if (line.done) return { kind: "refused", exit: await exit };
      const frame = object(JSON.parse(line.value)); assert.equal(frame.type, "ready"); assert.equal(frame.v, 1); return { kind: "ready", frame };
    },
    async call(operation: object): Promise<Record<string, unknown>> {
      const key = String(++id); child.stdin.write(JSON.stringify({ v: 1, id: key, operation }) + "\n");
      const line = await lines.next(); assert.equal(line.done, false); assert.ok(line.value !== undefined);
      const frame = object(JSON.parse(line.value)); assert.equal(frame.id, key); return frame;
    },
    async close(): Promise<void> { child.stdin.end(); const result = await exit; assert.equal(result.code, 0, result.errors); },
  };
}
function events(): Record<string, unknown>[] {
  const db = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT record_json FROM herdr_execution_records ORDER BY sequence").all().map(row => object(object(JSON.parse(String(row.record_json))).event)); }
  finally { db.close(); }
}
function binding(root: string): Record<string, unknown> {
  const db = new DatabaseSync(join(root, "host.sqlite"), { readOnly: true });
  try { const value = db.prepare("SELECT value FROM binding WHERE id=1").get()?.value; assert.ok(typeof value === "string"); return object(JSON.parse(value)); }
  finally { db.close(); }
}
async function until<T>(action: () => Promise<T | undefined>): Promise<T> {
  const end = performance.now() + 12000;
  while (performance.now() < end) { const value = await action(); if (value !== undefined) return value; await delay(20); }
  throw new Error("Downgrade observation deadline");
}
function refused(boot: Boot, message: RegExp): void {
  assert.equal(boot.kind, "refused"); assert.ok(boot.kind === "refused"); assert.equal(boot.exit.timedOut, false); assert.equal(boot.exit.code, 1); assert.match(boot.exit.errors, message);
}
let active: ReturnType<typeof start> | undefined;
const failures: unknown[] = [];
try {
  active = start(modern, enabled); assert.equal((await active.ready()).kind, "ready");
  assert.ok((await active.call({ op: "create", workspaceId: "coding", requestId: "create", cwd })).result);
  await active.call({ op: "submit", workspaceId: "coding", requestId: "native-refusal", content: "exercise actual EACCES" });
  await until(async () => events().length === 1 ? true : undefined);
  const before = events(); assert.deepEqual(before.map(event => event.kind), ["file.started"]);
  await active.close(); active = undefined; assert.equal(await readFile(file, "utf8"), "preserved\n"); await chmod(file, 0o600);
  active = start(old, enabled); const oldFullConfig = await active.ready(); if (oldFullConfig.kind === "ready") await active.close(); else await active.exit; active = undefined;
  refused(oldFullConfig, /HostError: Unknown field/);
  active = start(modern, disabled); const disabledCurrent = await active.ready(); if (disabledCurrent.kind === "ready") await active.close(); else await active.exit; active = undefined;
  refused(disabledCurrent, /HostError: (Host root identity differs|Managed execution evidence requires enabled ownership)/);
  assert.equal(await readFile(file, "utf8"), "preserved\n");
  active = start(old, disabled); const oldWithoutConfig = await active.ready(); let receipt: unknown;
  if (oldWithoutConfig.kind === "ready") {
    receipt = await active.call({ op: "submit", workspaceId: "coding", requestId: "old-binary-write", content: "write through legacy tools" });
    await until(async () => (await readFile(file, "utf8")) !== "preserved\n" ? true : undefined);
    await active.close();
  } else await active.exit;
  active = undefined;
  const bytes = await readFile(file, "utf8"), after = events();
  await writeFile(join(path, "old-binary-observation.json"), JSON.stringify({ path, modern, old, oldFullConfig, disabledCurrent, oldWithoutConfig, receipt, bytes, before, after, binding: binding(stateRoot) }, null, 2), { flag: "wx", mode: 0o600 });
  refused(oldWithoutConfig, /HostError: Host root identity differs/);
  assert.equal(bytes, "preserved\n"); assert.deepEqual(after, before); assert.equal(binding(stateRoot).version, 2);
  active = start(modern, enabled); assert.equal((await active.ready()).kind, "ready");
  const blocked = await active.call({ op: "submit", workspaceId: "coding", requestId: "still-blocked", content: "must not infer" });
  assert.equal(object(blocked.error).code, "effect_unresolved"); await active.close(); active = undefined;
  const legacyCwd = join(path, "legacy-workspace"), legacyRoot = join(path, "legacy-state"), legacyConfig = join(path, "legacy.json");
  await mkdir(legacyCwd, { mode: 0o700 });
  await writeFile(legacyConfig, JSON.stringify({ ...common, identity: { ...common.identity, deploymentId: "legacy-compatibility" }, stateRoot: legacyRoot }), { flag: "wx", mode: 0o600 });
  active = start(modern, legacyConfig); assert.equal((await active.ready()).kind, "ready");
  assert.ok((await active.call({ op: "create", workspaceId: "legacy", requestId: "legacy", cwd: legacyCwd })).result); await active.close(); active = undefined;
  assert.equal(binding(legacyRoot).version, 1);
  active = start(old, legacyConfig); assert.equal((await active.ready()).kind, "ready"); await active.call({ op: "snapshot", workspaceId: "legacy" }); await active.close(); active = undefined;
  const db = new DatabaseSync(join(stateRoot, "host.sqlite"));
  try { db.exec("PRAGMA synchronous=FULL"); db.prepare("UPDATE binding SET value=? WHERE id=1").run(JSON.stringify({ ...binding(stateRoot), version: 1 })); }
  finally { db.close(); }
  active = start(modern, enabled); const rolledBack = await active.ready(); if (rolledBack.kind === "ready") await active.close(); else await active.exit; active = undefined;
  refused(rolledBack, /HostError: Host root identity differs/); assert.equal(binding(stateRoot).version, 1); assert.equal(await readFile(file, "utf8"), "preserved\n"); assert.deepEqual(events(), before);
  const result = { proof: "actual-old-binary-managed-downgrade-refusal", path, modern, old, managedBindingVersion: 2, legacyBindingVersion: 1, oldConfigOmissionCannotBypassOwnership: true, unresolvedFilePreserved: true, managedReopenStillBlocksProgress: true, actualOldBinaryOpensLegacy: true, rolledBackManagedBindingRefused: true, modelCommandsRegistered: false };
  await writeFile(join(path, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(result));
} catch (error) { failures.push(error); }
if (active !== undefined) { active.child.kill("SIGKILL"); try { await active.exit; } catch (error) { failures.push(error); } }
if (failures.length) throw new AggregateError(failures, `Managed downgrade proof failed; preserve ${path}`);
