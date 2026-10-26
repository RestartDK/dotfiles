import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { HOST_VERSION, MAX_FRAME_BYTES, parseOperation, type HostConfig, type HostIdentity } from "#host-protocol";

const Identity = Type.Object({ deploymentId: Type.String(), domain: Type.Union([Type.Literal("work"), Type.Literal("personal")]), nodeId: Type.String() }, { additionalProperties: false });
const Ready = Type.Object({ v: Type.Literal(HOST_VERSION), type: Type.Literal("ready"), identity: Identity, bootId: Type.String({ minLength: 1 }), maxFrameBytes: Type.Literal(MAX_FRAME_BYTES), maxInFlight: Type.Literal(1), tools: Type.Array(Type.String()), commandOperations: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false });
const Reply = Type.Union([
  Type.Object({ v: Type.Literal(HOST_VERSION), id: Type.String(), result: Type.Unknown() }, { additionalProperties: false }),
  Type.Object({ v: Type.Literal(HOST_VERSION), id: Type.String(), error: Type.Object({ code: Type.String(), message: Type.String() }, { additionalProperties: false }) }, { additionalProperties: false }),
]);
const Status = Type.Object({ workspaceId: Type.Literal("coding"), requestId: Type.Literal("same-request"), receipt: Type.Union([Type.Null(), Type.Object({ status: Type.String() }, { additionalProperties: true })]) }, { additionalProperties: false });
const Completed = Type.Object({ conversationId: Type.Integer({ minimum: 1 }), requestId: Type.Literal("same-request"), type: Type.Literal("input"), status: Type.Literal("done"), entry: Type.Integer({ minimum: 1 }), id: Type.Integer({ minimum: 1 }), answer: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const Snapshot = Type.Object({ workspace: Type.Object({ domain: Identity.properties.domain, nodeId: Type.String(), workspaceId: Type.Literal("coding"), cwd: Type.String(), conversationId: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }), entries: Type.Array(Type.Unknown(), { minItems: 1 }), hasMore: Type.Boolean() }, { additionalProperties: false });
const Binding = Type.Object({ ...Identity.properties, stateRoot: Type.String(), version: Type.Literal(2) }, { additionalProperties: false });
function parsed<T extends TSchema>(schema: T, value: unknown): Static<T> { assert.ok(Check(schema, value), "Invalid deployment proof response"); return value; }
function nodeReference(): string { const value = process.env.DSTACK_TEST_NODE; assert.ok(typeof value === "string" && value.startsWith("/nix/store/")); return value; }
const node = nodeReference();
const fixture = fileURLToPath(new URL("./host-fixture.js", import.meta.url));
await access(node); await access(fixture);
const root = await mkdtemp(join(tmpdir(), "host-domains-"));
type Exit = { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly errors: string; readonly timedOut: boolean };
type Boot = { readonly kind: "ready"; readonly frame: Static<typeof Ready> } | { readonly kind: "refused"; readonly exit: Exit };
function start(config: string) {
  const child = spawn(node, [fixture, config], { stdio: ["pipe", "pipe", "pipe"] });
  let errors = "", timedOut = false, id = 0;
  child.stderr.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(0, 32768); });
  const exit = new Promise<Exit>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, errors, timedOut })); });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20000);
  void exit.then(() => clearTimeout(timer), () => clearTimeout(timer));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
  return {
    child, exit,
    async ready(): Promise<Boot> { const line = await lines.next(); return line.done ? { kind: "refused", exit: await exit } : { kind: "ready", frame: parsed(Ready, JSON.parse(line.value)) }; },
    async call(input: unknown): Promise<unknown> {
      const operation = parseOperation(input), key = String(++id); child.stdin.write(JSON.stringify({ v: HOST_VERSION, id: key, operation }) + "\n");
      const line = await lines.next(); assert.equal(line.done, false); assert.ok(line.value !== undefined);
      const frame = parsed(Reply, JSON.parse(line.value)); assert.equal(frame.id, key); assert.ok("result" in frame, JSON.stringify(frame)); return frame.result;
    },
    async close(): Promise<void> { child.stdin.end(); const result = await exit; assert.equal(result.timedOut, false); assert.equal(result.code, 0, result.errors); },
  };
}
async function until<T>(action: () => Promise<T | undefined>): Promise<T> {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) { const value = await action(); if (value !== undefined) return value; await delay(20); }
  throw new Error("Independent deployment observation deadline");
}
async function configuration(domain: HostIdentity["domain"]) {
  const path = join(root, domain), cwd = join(path, "workspace"), file = join(path, "config.json");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const config = { identity: { deploymentId: `parallel-${domain}`, domain, nodeId: "fixture" }, stateRoot: join(path, "state"), model: { provider: "host-fixture", modelId: "files" }, thinkingLevel: "off", authPath: join(path, "unused-auth.json"), modelsPath: join(path, "unused-models.json"), execution: { mode: "durable", maxRecords: 256 } } satisfies HostConfig;
  await writeFile(file, JSON.stringify(config), { flag: "wx", mode: 0o600 }); return { config, file, cwd };
}
const [workConfig, personalConfig] = await Promise.all([configuration("work"), configuration("personal")]);
function binding(stateRoot: string): Static<typeof Binding> {
  const db = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
  try { const value = db.prepare("SELECT value FROM binding WHERE id=1").get()?.value; assert.ok(typeof value === "string"); return parsed(Binding, JSON.parse(value)); }
  finally { db.close(); }
}
const owners: ReturnType<typeof start>[] = [], failures: unknown[] = [];
function expectedReady(boot: Boot): Static<typeof Ready> { assert.ok(boot.kind === "ready"); return boot.frame; }
async function completed(owner: ReturnType<typeof start>): Promise<Static<typeof Completed>> {
  return until(async () => {
    const status = parsed(Status, await owner.call({ op: "status", workspaceId: "coding", requestId: "same-request" }));
    return status.receipt?.status === "done" ? parsed(Completed, status.receipt) : undefined;
  });
}
try {
  const work = start(workConfig.file); owners.push(work);
  const personal = start(personalConfig.file); owners.push(personal);
  const workReady = expectedReady(await work.ready()), personalReady = expectedReady(await personal.ready());
  const deployments = [{ ...workConfig, owner: work, ready: workReady }, { ...personalConfig, owner: personal, ready: personalReady }];
  for (const deployment of deployments) {
    assert.deepEqual(deployment.ready.identity, deployment.config.identity); assert.deepEqual(deployment.ready.tools, ["read", "write", "edit"]);
    assert.deepEqual(deployment.ready.commandOperations, ["execution.status", "file.reconcile"]);
  }
  assert.notEqual(workReady.bootId, personalReady.bootId); assert.notEqual(work.child.pid, personal.child.pid);
  const collision = start(workConfig.file); owners.push(collision);
  const refused = await collision.ready(); assert.ok(refused.kind === "refused"); assert.equal(refused.exit.timedOut, false); assert.equal(refused.exit.code, 1); assert.match(refused.exit.errors, /Another daemon owns/);
  await Promise.all(deployments.map(deployment => deployment.owner.call({ op: "create", workspaceId: "coding", requestId: "create", cwd: deployment.cwd })));
  await Promise.all(deployments.map(deployment => deployment.owner.call({ op: "submit", workspaceId: "coding", requestId: "same-request", content: "Write an independent file" })));
  const [workReceipt, personalReceipt] = await Promise.all([completed(work), completed(personal)]);
  const before = parsed(Snapshot, await personal.call({ op: "snapshot", workspaceId: "coding" })); assert.equal(before.workspace.conversationId, personalReceipt.conversationId);
  const [workFile, personalFile] = await Promise.all([stat(join(workConfig.config.stateRoot, "host.sqlite"), { bigint: true }), stat(join(personalConfig.config.stateRoot, "host.sqlite"), { bigint: true })]);
  assert.notEqual(`${workFile.dev}:${workFile.ino}`, `${personalFile.dev}:${personalFile.ino}`);
  const bindings = deployments.map(deployment => {
    const value = binding(deployment.config.stateRoot); assert.deepEqual(value, { ...deployment.config.identity, stateRoot: deployment.config.stateRoot, version: 2 }); return value;
  });
  await work.close();
  const after = parsed(Snapshot, await personal.call({ op: "snapshot", workspaceId: "coding" })); assert.deepEqual(after, before);
  assert.deepEqual(parsed(Completed, parsed(Status, await personal.call({ op: "status", workspaceId: "coding", requestId: "same-request" })).receipt), personalReceipt);
  for (const deployment of deployments) assert.equal(await readFile(join(deployment.cwd, "proof.txt"), "utf8"), "host-owned\n");
  await personal.close();
  const result = { proof: "simultaneous-independent-work-personal-node-owners", root, node, fixture, identities: [workReady.identity, personalReady.identity], receipts: [workReceipt, personalReceipt], bindings, sameStoreConcurrentOwnerRefused: true, distinctActualSqliteInodes: true, otherDeploymentUnchangedAfterOwnerClose: true, noModelCommands: true, authenticatedIngressQualified: false };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(result));
} catch (error) { failures.push(error); }
finally {
  for (const owner of owners) { if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill("SIGKILL"); try { await owner.exit; } catch (error) { failures.push(error); } }
}
if (failures.length) throw new AggregateError(failures, `Independent deployment proof failed; preserve ${root}`);
