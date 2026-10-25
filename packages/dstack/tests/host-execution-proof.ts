import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
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
  let settled = false;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = object(await active.handle(parseOperation({ op: "status", workspaceId: "first", requestId: "files" })));
    if (result.receipt !== null && object(result.receipt).status === "done") { settled = true; break; }
    await delay(20);
  }
  assert.ok(settled, "Managed host submission must settle");
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

  process.stdout.write(`${JSON.stringify({ event: "pass", proof: "managed-host", path, actualSdkNativeMutation: true, actualSdkProtectedControlAndAuth: true, multipleWorkspacesPreparedBeforeHarness: true, missingExpectedSdkNotAllocated: true, disabledAndMissingPairedEvidenceRefused: true, modelCommandRegistered: false, commandOwnerIntegrated: false, actualProcessKill: false })}\n`);
} catch (error) { failures.push(error); }
Harness.open = originalOpen;
try { await active?.close(); } catch (error) { failures.push(error); }
if (failures.length !== 0) throw new AggregateError(failures, `Managed host proof or cleanup failed; preserve ${path}`);
