import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { CodingWorkspaceOwner, CodingWorkspaceDoc, type OpenCodingWorkspaceOptions } from "#coding-workspace";
import { ExecutionRootDoc } from "#execution-binding";
import { executionRootBytes } from "#execution-wire";

const path = await mkdtemp(join(tmpdir(), "dstack-execution-binding-"));
const cwd = join(path, "workspace"); await mkdir(cwd, { mode: 0o700 });
const faux = fauxProvider({ api: "binding-fixture", provider: "binding-fixture", models: [{ id: "model", input: ["text"] }] });
const models = createModels(); models.setProvider(faux.provider);
const model = faux.getModel();
const workspace = { domain: "personal", nodeId: "binding-fixture", workspaceId: "coding", cwd } satisfies OpenCodingWorkspaceOptions["workspace"];
const root = { version: 1, rootId: randomUUID(), token: randomBytes(32).toString("hex"), workspace } satisfies NonNullable<OpenCodingWorkspaceOptions["management"]>["root"];
const context = withAbortSignal(AbortSignal.timeout(20000), BACKGROUND_CONTEXT);
const common = { workspace, models, model: { provider: model.provider, modelId: model.id }, execution: "trusted-user", lockCommand: { file: process.env.DSTACK_FLOCK ?? "flock", args: [] }, registry: createRegistry() } satisfies Omit<OpenCodingWorkspaceOptions, "stateDirectory">;
const legacy = { ...common, stateDirectory: join(path, "legacy") };
const managed = { ...common, stateDirectory: join(path, "managed") };
let owner: CodingWorkspaceOwner | undefined;
const failures: unknown[] = [];
const originalOpen = Harness.open;
let resumeCalls = 0;
Harness.open = async (...args) => {
  const harness = await originalOpen(...args);
  const resume = harness.resume.bind(harness);
  harness.resume = (...args) => {
    resumeCalls += 1;
    return resume(...args);
  };
  return harness;
};
try {
  owner = await CodingWorkspaceOwner.open(legacy, context);
  const legacyConversation = owner.conversation.id;
  assert.equal(resumeCalls, 1);
  await owner.close(); owner = undefined;
  await assert.rejects(CodingWorkspaceOwner.open({ ...legacy, management: { root, initialization: "new" } }, context), /existing coding store/);
  await assert.rejects(CodingWorkspaceOwner.open({ ...legacy, management: { root, initialization: "existing" } }, context), /identity is missing or changed/);
  owner = await CodingWorkspaceOwner.open(legacy, context);
  assert.equal(owner.conversation.id, legacyConversation);
  await owner.close(); owner = undefined;

  const legacyResumeCalls = resumeCalls;
  owner = await CodingWorkspaceOwner.open({ ...managed, management: { root, initialization: "new" } }, context);
  assert.equal(resumeCalls, legacyResumeCalls);
  const originalConversation = owner.conversation.id;
  await owner.harness.commit(async tx => {
    const marker = await tx.doc(ExecutionRootDoc);
    const coding = await tx.doc(CodingWorkspaceDoc);
    assert.equal(marker.rootJson, executionRootBytes(root));
    assert.deepEqual(coding.workspace, workspace);
  }, context);
  await owner.close(); owner = undefined;
  await assert.rejects(CodingWorkspaceOwner.open(managed, context), /requires execution ownership/);
  await assert.rejects(CodingWorkspaceOwner.open({ ...managed, management: { root, initialization: "new" } }, context), /existing coding store/);
  await assert.rejects(CodingWorkspaceOwner.open({ ...managed, management: { root: { ...root, token: "f".repeat(64) }, initialization: "existing" } }, context), /identity is missing or changed/);
  owner = await CodingWorkspaceOwner.open({ ...managed, management: { root, initialization: "existing" } }, context);
  assert.equal(owner.conversation.id, originalConversation);
  assert.equal(resumeCalls, legacyResumeCalls);
  await owner.harness.commit(async tx => { (await tx.doc(ExecutionRootDoc)).rootJson = null; }, context);
  await owner.close(); owner = undefined;
  await assert.rejects(CodingWorkspaceOwner.open({ ...managed, management: { root, initialization: "existing" } }, context), /identity is missing or changed/);
  const result = { path, verdict: "sdk-execution-marker-component-only", legacyReopenPreserved: true, implicitM2UpgradeRefused: true, managedIdentityAndDisabledConfigurationRefused: true, missingMarkerRefusedWhenExpectedManaged: true, startupResumeDeferred: true, allProgressPathsGated: false, globalExecutionIndexImplemented: false, hostIntegrated: false, modelCommandToolRegistered: false, actualProcessKill: false };
  await writeFile(join(path, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) { failures.push(error); }
Harness.open = originalOpen;
try { await owner?.close(); } catch (error) { failures.push(error); }
if (failures.length) throw new AggregateError(failures, "SDK execution marker proof or cleanup failed");
