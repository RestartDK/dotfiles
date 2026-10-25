import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { CodingWorkspaceOwner } from "#coding-workspace";
import { DurableHost } from "#durable-host";
import { ExecutionRootDoc } from "#execution-binding";
import { parseExecutionRoot } from "#execution-wire";
import { parseHostConfig, parseOperation, type HostConfig } from "#host-protocol";

const path = await mkdtemp(join(tmpdir(), "dstack-managed-host-"));
const faux = fauxProvider({ api: "managed-host-fixture", provider: "managed-host-fixture", models: [{ id: "files", input: ["text"] }] });
const models = createModels(); models.setProvider(faux.provider);
const model = faux.getModel();
const originalOpen = Harness.open;
let harnessOpens = 0;
Harness.open = async (...args) => { harnessOpens += 1; return originalOpen(...args); };
let active: DurableHost | undefined;
const failures: unknown[] = [];

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
async function fixture(name: string): Promise<HostConfig> {
  const cwd = join(path, name); await mkdir(cwd, { mode: 0o700 });
  const config = parseHostConfig({
    identity: { deploymentId: "managed-host", domain: "personal", nodeId: "fixture" },
    stateRoot: join(cwd, "state"), model: { provider: model.provider, modelId: model.id }, thinkingLevel: "off",
    authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json"), execution: { mode: "durable", maxRecords: 256 },
  });
  active = await DurableHost.open(config, models, { protectedPaths: [join(cwd, "config.json")] });
  for (const workspaceId of ["first", "second"])
    await active.handle(parseOperation({ op: "create", requestId: `create-${workspaceId}`, workspaceId, cwd }));
  await active.close(); active = undefined;
  return config;
}
function store(config: HostConfig, workspaceId: string) {
  return join(config.stateRoot, createHash("sha256").update(workspaceId).digest("hex"));
}
function database(config: HostConfig): DatabaseSync {
  const db = new DatabaseSync(join(config.stateRoot, "host.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  return db;
}
function root(config: HostConfig, workspaceId: string) {
  const db = database(config);
  try {
    const row = db.prepare("SELECT root_json FROM herdr_managed_workspaces WHERE workspace_id=?").get(workspaceId);
    assert.equal(typeof row?.root_json, "string");
    assert.ok(typeof row?.root_json === "string");
    return parseExecutionRoot(row.root_json);
  } finally { db.close(); }
}
async function submissionDone(host: DurableHost, requestId: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = object(await host.handle(parseOperation({ op: "status", workspaceId: "first", requestId })));
    if (result.receipt !== null && object(result.receipt).status === "done") return;
    await delay(20);
  }
  throw new Error(`Managed host submission did not settle: ${requestId}`);
}
async function refusesBeforeHarness(config: HostConfig) {
  const before = harnessOpens;
  await assert.rejects(DurableHost.open(config, models));
  assert.equal(harnessOpens, before, "Composite boot refusal must precede every Harness.open");
}

try {
  const config = await fixture("files");
  const cwd = join(path, "files");
  const configPath = join(cwd, "config.json");
  await writeFile(config.authPath, "private-fixture-sentinel", { mode: 0o600 });
  await writeFile(configPath, "preserved-control", { mode: 0o600 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "proof.txt", content: "managed\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("read", { path: "auth.json" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("write", { path: "config.json", content: "overwrite" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  active = await DurableHost.open(config, models, { protectedPaths: [configPath] });
  await assert.rejects(DurableHost.open(config, models), /Another daemon owns this state directory/);
  await active.handle(parseOperation({ op: "submit", requestId: "files", workspaceId: "first", content: "exercise managed files" }));
  await submissionDone(active, "files");
  assert.equal(await readFile(join(cwd, "proof.txt"), "utf8"), "managed\n");
  assert.equal(await readFile(config.authPath, "utf8"), "private-fixture-sentinel");
  assert.equal(await readFile(configPath, "utf8"), "preserved-control");
  const snapshot = await active.handle(parseOperation({ op: "snapshot", workspaceId: "first" }));
  assert.ok(!JSON.stringify(snapshot).includes("private-fixture-sentinel"));
  await active.close(); active = undefined;
  const db = database(config);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM herdr_managed_workspaces").get()?.n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM herdr_execution_records").get()?.n, 2, "Only the permitted native mutation may record started/adopted");
  } finally { db.close(); }
  active = await DurableHost.open(config, models, { protectedPaths: [configPath] });
  assert.equal(await readFile(join(cwd, "proof.txt"), "utf8"), "managed\n");
  await active.close(); active = undefined;
  const { execution: _disabled, ...disabled } = config;
  await refusesBeforeHarness(disabled);

  const recovery = await fixture("file-reconcile");
  const recoveryCwd = join(path, "file-reconcile");
  const refusedFile = join(recoveryCwd, "refused.txt");
  await writeFile(refusedFile, "preserved\n", { mode: 0o400 });
  await chmod(refusedFile, 0o400);
  const callsBeforeFailure = faux.state.callCount;
  faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: "refused.txt", content: "must not write\n" }), { stopReason: "toolUse" })]);
  active = await DurableHost.open(recovery, models);
  assert.deepEqual(active.nativeCommandOperations, ["execution.status", "file.reconcile"]);
  await active.handle(parseOperation({ op: "submit", requestId: "native-write-refusal", workspaceId: "first", content: "exercise native failure and explicit recovery" }));
  let effectId: string | undefined;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const status = object(await active.handle(parseOperation({ op: "execution.status", workspaceId: "first" })));
    assert.ok(Array.isArray(status.unresolved));
    if (status.unresolved.length !== 0) {
      const pending = object(status.unresolved[0]);
      assert.equal(pending.kind, "file");
      assert.equal(typeof pending.effectId, "string");
      if (typeof pending.effectId === "string") effectId = pending.effectId;
      break;
    }
    await delay(20);
  }
  assert.ok(effectId, "Native mutation failure must retain its actual unresolved effect");
  await active.close(); active = undefined;
  assert.equal(await readFile(refusedFile, "utf8"), "preserved\n");
  active = await DurableHost.open(recovery, models);
  assert.equal(faux.state.callCount, callsBeforeFailure + 1, "Unresolved mutation and reopen must not dispatch another inference");
  const blocked = object(await active.handle(parseOperation({ op: "execution.status", workspaceId: "first" })));
  assert.deepEqual(blocked.unresolved, [{ kind: "file", effectId }]);
  await active.handle(parseOperation({ op: "file.reconcile", workspaceId: "first", effectId, reference: "operator inspected preserved file after owned SDK close" }));
  assert.deepEqual(object(await active.handle(parseOperation({ op: "execution.status", workspaceId: "first" }))).unresolved, []);
  faux.setResponses([fauxAssistantMessage(fauxToolCall("write", { path: "after-reconcile.txt", content: "new approved turn\n" }), { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
  await active.handle(parseOperation({ op: "submit", requestId: "after-file-reconcile", workspaceId: "first", content: "explicit new input after reconciliation" }));
  await submissionDone(active, "after-file-reconcile");
  assert.equal(await readFile(join(recoveryCwd, "after-reconcile.txt"), "utf8"), "new approved turn\n");
  assert.equal(await readFile(refusedFile, "utf8"), "preserved\n");
  assert.deepEqual(object(await active.handle(parseOperation({ op: "execution.status", workspaceId: "first" }))).unresolved, []);
  await active.close(); active = undefined;

  const missing = await fixture("missing-sdk");
  const sdk = join(store(missing, "second"), "conversation.sqlite");
  await rename(sdk, `${sdk}.preserved`);
  await refusesBeforeHarness(missing);
  await assert.rejects(lstat(sdk), { code: "ENOENT" });
  assert.ok((await lstat(`${sdk}.preserved`)).isFile());

  const marker = await fixture("missing-marker");
  const expected = root(marker, "second");
  const owner = await CodingWorkspaceOwner.open({
    stateDirectory: store(marker, "second"), workspace: expected.workspace, model: marker.model, models,
    registry: createRegistry(), management: { root: expected, initialization: "existing" }, execution: "trusted-user",
    lockCommand: { file: process.env.DSTACK_FLOCK ?? "flock", args: [] },
  }, BACKGROUND_CONTEXT);
  try { await owner.harness.commit(async tx => { (await tx.doc(ExecutionRootDoc)).rootJson = null; }, BACKGROUND_CONTEXT); }
  finally { await owner.close(); }
  await refusesBeforeHarness(marker);

  const journal = await fixture("missing-journal");
  const journalDb = database(journal);
  try { journalDb.prepare("DELETE FROM herdr_execution_roots WHERE id=?").run(root(journal, "second").rootId); }
  finally { journalDb.close(); }
  await refusesBeforeHarness(journal);

  const orphan = await fixture("orphan-sdk");
  const orphanDb = database(orphan);
  try { orphanDb.prepare("DELETE FROM workspaces WHERE id='second'").run(); }
  finally { orphanDb.close(); }
  await refusesBeforeHarness(orphan);

  const catalogue = await fixture("missing-catalogue");
  const index = join(catalogue.stateRoot, "execution", "catalogue", "index.json");
  await rename(index, `${index}.preserved`);
  await refusesBeforeHarness(catalogue);
  assert.ok((await lstat(`${index}.preserved`)).isFile());

  process.stdout.write(`${JSON.stringify({ event: "pass", proof: "managed-host", path, actualSdkNativeMutation: true, actualSdkProtectedControlAndAuth: true, actualNativeFileFailureReopenedWithoutInference: true, explicitFileReconciliationWithoutCommandRuntime: true, multipleWorkspacesPreparedBeforeHarness: true, missingExpectedSdkNotAllocated: true, disabledAndMissingPairedEvidenceRefused: true, modelCommandRegistered: false, commandOwnerIntegrated: false, actualProcessKill: false })}\n`);
} catch (error) { failures.push(error); }
Harness.open = originalOpen;
try { await active?.close(); } catch (error) { failures.push(error); }
if (failures.length !== 0) throw new AggregateError(failures, `Managed host proof or cleanup failed; preserve ${path}`);
