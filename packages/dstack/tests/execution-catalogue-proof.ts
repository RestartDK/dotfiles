import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CommandDirectory } from "#command-store";
import { ExecutionCatalogue } from "#execution-catalogue";
import { executionRootBytes, type ExecutionRoot } from "#execution-wire";
import { parseHostConfig, parseOperation } from "#host-protocol";
import { DurableHost } from "#durable-host";
import { createModels } from "@earendil-works/pi-ai";

const path = await mkdtemp(join(tmpdir(), "dstack-catalogue-"));
const cwd = join(path, "workspace"), stateRoot = join(path, "state");
await mkdir(cwd, { mode: 0o700 });
const config = parseHostConfig({ identity: { deploymentId: "catalogue-deployment", domain: "personal", nodeId: "catalogue-fixture" }, stateRoot, model: { provider: "not-called", modelId: "not-called" }, thinkingLevel: "high", authPath: join(path, "unused-auth.json"), modelsPath: join(path, "unused-models.json") });
const host = await DurableHost.open(config, createModels()); await host.close();
const db = new DatabaseSync(join(stateRoot, "host.sqlite"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
const identity = config.identity;
const evidence = join(stateRoot, "execution"); await mkdir(evidence, { mode: 0o700 });
const lease = await CommandDirectory.own({ path: evidence, lockCommand: { file: process.env.DSTACK_FLOCK ?? "flock", args: [] } });
let catalogue: ExecutionCatalogue | undefined;
const failures: unknown[] = [];
function root(workspaceId: string): ExecutionRoot {
  return { version: 1, rootId: randomUUID(), token: randomBytes(32).toString("hex"), workspace: { domain: identity.domain, nodeId: identity.nodeId, workspaceId, cwd } };
}
function operation(workspaceId: string, requestId = `create-${workspaceId}`) {
  const value = parseOperation({ op: "create", workspaceId, requestId, cwd });
  if (value.op !== "create") throw new Error("Expected actual parsed create operation");
  return value;
}
const filename = (workspaceId: string) => createHash("sha256").update(workspaceId).digest("hex") + ".json";
try {
  const directory = await lease.directory.child("catalogue", "new");
  const options = { db, directory, identity };
  catalogue = await ExecutionCatalogue.initialize(options);
  assert.equal((await catalogue.snapshot()).length, 0);
  const alpha = root("alpha"), input = { ...alpha };
  const admitted = catalogue.admit({ root: input, operation: operation("alpha") });
  input.token = "f".repeat(64);
  const result = await admitted;
  assert.equal(result.kind, "created");
  assert.equal(result.entry.root.token, alpha.token);
  assert.equal((await catalogue.admit({ root: alpha, operation: operation("alpha") })).kind, "attached");
  await assert.rejects(catalogue.admit({ root: { ...alpha, token: "f".repeat(64) }, operation: operation("alpha") }), /conflicts/);
  await catalogue.assertBinding(alpha);
  await assert.rejects(catalogue.admit({ root: { ...alpha, workspace: { ...alpha.workspace, workspaceId: "shared-root" } }, operation: operation("shared-root") }), /root identity already/);
  assert.equal(db.prepare("SELECT id FROM workspaces WHERE id='shared-root'").get(), undefined);
  assert.equal((await catalogue.snapshot()).length, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM workspaces").get()?.n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM admissions").get()?.n, 1);
  db.prepare("INSERT INTO workspaces VALUES (?, ?)").run("legacy", cwd);
  await assert.rejects(catalogue.admit({ root: root("legacy"), operation: operation("legacy") }), /implicitly/);
  assert.equal((await catalogue.snapshot()).length, 1);
  const roots = await directory.child("roots", "existing");
  const quarantine = join(path, "quarantine"); await mkdir(quarantine, { mode: 0o700 });
  await rename(join(roots.path, filename("alpha")), join(quarantine, "alpha.json"));
  await assert.rejects(catalogue.snapshot(), /ENOENT/);
  await rename(join(quarantine, "alpha.json"), join(roots.path, filename("alpha")));
  db.exec("BEGIN IMMEDIATE");
  try { db.prepare("DELETE FROM herdr_managed_workspaces WHERE workspace_id=?").run("alpha"); await assert.rejects(catalogue.snapshot(), /orphaned/); }
  finally { db.exec("ROLLBACK"); }
  await roots.create("orphan.json", executionRootBytes(alpha));
  await assert.rejects(catalogue.snapshot(), /orphaned/);
  await catalogue.assertBinding(alpha);
  await rename(join(roots.path, "orphan.json"), join(quarantine, "orphan.json"));
  const gamma = root("gamma"), original = CommandDirectory.prototype.create;
  try {
    CommandDirectory.prototype.create = async function (name, bytes) {
      await original.call(this, name, bytes);
      if (name === filename("gamma")) db.exec("PRAGMA synchronous=NORMAL");
    };
    await assert.rejects(catalogue.admit({ root: gamma, operation: operation("gamma") }), /FULL SQLite synchronization/);
  } finally { CommandDirectory.prototype.create = original; db.exec("PRAGMA synchronous=FULL"); }
  assert.equal(db.prepare("SELECT id FROM workspaces WHERE id='gamma'").get(), undefined);
  assert.equal(db.prepare("SELECT id FROM admissions WHERE id='create-gamma'").get(), undefined);
  await assert.rejects(catalogue.snapshot(), /orphaned/);
  await rename(join(roots.path, filename("gamma")), join(quarantine, "late-policy-gamma.json"));
  db.exec("BEGIN IMMEDIATE");
  try { db.prepare("UPDATE herdr_execution_index SET anchor_json='{}'").run(); await assert.rejects(catalogue.snapshot(), /anchor/); }
  finally { db.exec("ROLLBACK"); }
  const pending = catalogue.snapshot(), closing = catalogue.close();
  assert.equal(catalogue.close(), closing); await pending; await closing;
  await assert.rejects(catalogue.snapshot(), /closed/);
  catalogue = await ExecutionCatalogue.open(options);
  assert.equal((await catalogue.snapshot()).length, 1);
  await assert.rejects(ExecutionCatalogue.open({ ...options, identity: { ...identity, nodeId: "other" } }), /host index/);
  await assert.rejects(ExecutionCatalogue.open({ ...options, identity: { ...identity, deploymentId: "other-deployment" } }), /host index/);
  await catalogue.close(); catalogue = undefined;
  db.prepare("SELECT id FROM workspaces").all();
  await directory.read("index.json", 16384);
  const verdict = { path, verdict: "paired-host-catalogue-component-only", actualHostFactorySchema: true, deploymentIdentityBound: true, duplicateRootIdentityRefusedBeforePublication: true, immutableInputAndAtomicHostAdmission: true, sameRequestAttachesChangedRootRefuses: true, m2UpgradeRefused: true, missingAndOrphanCopiesRefused: true, latePolicyDriftBeforeSqliteRefused: true, scopedBindingIgnoresUnrelatedOrphan: true, borrowedResourcesRemainOpen: true, sdkAndHostWiringImplemented: false, commandRan: false };
  await writeFile(join(path, "result.json"), JSON.stringify(verdict, null, 2), { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
} catch (error) { failures.push(error); }
try { await catalogue?.close(); } catch (error) { failures.push(error); }
try { db.close(); } catch (error) { failures.push(error); }
try { await lease.close(); } catch (error) { failures.push(error); }
if (failures.length) throw new AggregateError(failures, "Execution catalogue proof or cleanup failed");
