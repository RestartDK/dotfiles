import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, open, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { EditToolInput, ReadToolInput, WriteToolInput } from "@earendil-works/pi-durable/tools";
import { CodingWorkspaceOwner } from "#coding-workspace";
import { CommandDirectory } from "#command-store";
import { ExecutionJournal } from "#execution-journal";
import { executionDigest } from "#execution-wire";
import { executionFileTools } from "#execution-files";
import { WorkspacePaths } from "#workspace-paths";

const path = await mkdtemp(join(tmpdir(), "dstack-files-"));
const cwd = join(path, "workspace"), evidence = join(path, "evidence");
await mkdir(cwd, { mode: 0o700 });
await mkdir(evidence, { mode: 0o700 });
const databasePath = join(path, "host.sqlite");
const file = await open(databasePath, "wx", 0o600); await file.close();
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
const lease = await CommandDirectory.own({ path: evidence, lockCommand: { file: process.env.DSTACK_FLOCK || "flock", args: [] } });
const workspace = { domain: "personal", nodeId: "file-fixture", workspaceId: "files", cwd } satisfies Parameters<typeof CodingWorkspaceOwner.open>[0]["workspace"];
let journal: ExecutionJournal | undefined;
let owner: CodingWorkspaceOwner | undefined;
const failures: unknown[] = [];
try {
  journal = await ExecutionJournal.initialize({ db, directory: lease.directory, root: { version: 1, rootId: randomUUID(), token: randomBytes(32).toString("hex"), workspace }, maxRecords: 64 });
  await writeFile(join(cwd, "operator file.json"), "fake-auth");
  await writeFile(join(cwd, "operator’s.json"), "fake-auth");
  await writeFile(join(path, "external-auth.json"), "fake-auth");
  await symlink(join(cwd, "data.txt"), join(cwd, "link.txt"));
  await link(join(path, "external-auth.json"), join(cwd, "hardlink.json"));
  const paths = await WorkspacePaths.open({ cwd, protectedPaths: [evidence, join(path, "coding"), join(cwd, "operator file.json"), join(cwd, "operator’s.json")] });
  type FileCase = { readonly id: string; readonly error: boolean } & (
    | { readonly tool: "read"; readonly args: ReadToolInput }
    | { readonly tool: "write"; readonly args: WriteToolInput }
    | { readonly tool: "edit"; readonly args: EditToolInput }
  );
  const cases: readonly FileCase[] = [
    { id: "first-write", tool: "write", args: { path: "data.txt", content: "before" }, error: false },
    { id: "bad-edit", tool: "edit", args: { path: "data.txt", edits: [{ oldText: "absent", newText: "changed" }] }, error: true },
    { id: "good-edit", tool: "edit", args: { path: "data.txt", edits: [{ oldText: "before", newText: "after" }] }, error: false },
    { id: "normal-read", tool: "read", args: { path: "data.txt" }, error: false },
    { id: "escape-write", tool: "write", args: { path: "../never-created", content: "forbidden" }, error: true },
    { id: "unicode-protected", tool: "write", args: { path: "operator\u00a0file.json", content: "forbidden" }, error: true },
    { id: "read-fallback", tool: "read", args: { path: "operator's.json" }, error: true },
    { id: "hardlink-read", tool: "read", args: { path: "hardlink.json" }, error: true },
    { id: "symlink-write", tool: "write", args: { path: "link.txt", content: "forbidden" }, error: true },
    { id: "blocked-write", tool: "write", args: { path: "blocked.txt", content: "forbidden" }, error: true },
  ];
  const faux = fauxProvider({ api: "execution-file-fixture", provider: "execution-file-fixture", models: [{ id: "files", input: ["text"] }], tokenSize: { min: 4096, max: 4096 } });
  const rounds = [
    { id: "write-round", calls: [fauxToolCall("write", { path: "round-first.txt", content: "first" }, { id: "round-write-first" }), fauxToolCall("write", { path: "round-second.txt", content: "second" }, { id: "round-write-second" })] },
    { id: "edit-round", calls: [fauxToolCall("edit", { path: "round-first.txt", edits: [{ oldText: "first", newText: "first-edited" }] }, { id: "round-edit-first" }), fauxToolCall("edit", { path: "round-second.txt", edits: [{ oldText: "second", newText: "second-edited" }] }, { id: "round-edit-second" })] },
  ];
  faux.setResponses([
    ...rounds.flatMap(round => [fauxAssistantMessage(round.calls, { stopReason: "toolUse" }), fauxAssistantMessage("done")]),
    ...cases.flatMap(item => [fauxAssistantMessage(fauxToolCall(item.tool, item.args, { id: item.id }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]),
  ]);
  const models = createModels(); models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry = createRegistry(); registry.install(executionFileTools({ journal, paths }));
  const context = withAbortSignal(AbortSignal.timeout(30_000), BACKGROUND_CONTEXT);
  owner = await CodingWorkspaceOwner.open({ stateDirectory: join(path, "coding"), workspace, models, model: { provider: model.provider, modelId: model.id }, execution: "trusted-user", lockCommand: { file: process.env.DSTACK_FLOCK || "flock", args: [] }, registry }, context);
  for (const round of rounds) {
    const submission = await owner.conversation.submit({ type: "input", requestId: round.id, content: `Fixture ${round.id}.` }, context);
    await submission.wait(context);
    const page: Awaited<ReturnType<CodingWorkspaceOwner["conversation"]["entries"]>> = await owner.conversation.entries({}, 256, undefined, context);
    for (const call of round.calls) {
      const message = page.items.flatMap(entry => entry.model ?? []).find(entry => entry.role === "toolResult" && entry.toolCallId === call.id);
      assert.ok(message?.role === "toolResult");
      assert.equal(message.isError, false, `${round.id} must serialize every fresh mutation`);
    }
  }
  assert.equal(await readFile(join(cwd, "round-first.txt"), "utf8"), "first-edited");
  assert.equal(await readFile(join(cwd, "round-second.txt"), "utf8"), "second-edited");
  for (const item of cases) {
    if (item.id === "blocked-write") {
      await journal.append({ kind: "file.started", effectId: executionDigest("injected-unresolved"), tool: "write", path: join(cwd, "injected-never-written"), argumentsSha256: executionDigest("synthetic-unresolved"), sdk: { taskKey: "synthetic-unresolved", conversationKey: "synthetic", callId: "synthetic" } });
    }
    const submission = await owner.conversation.submit({ type: "input", requestId: item.id, content: `Fixture ${item.id}.` }, context);
    await submission.wait(context);
    const page: Awaited<ReturnType<CodingWorkspaceOwner["conversation"]["entries"]>> = await owner.conversation.entries({}, 256, undefined, context);
    const message = page.items.flatMap(entry => entry.model ?? []).find(entry => entry.role === "toolResult" && entry.toolCallId === item.id);
    assert.ok(message?.role === "toolResult", `Missing actual SDK result for ${item.id}`);
    assert.equal(message.isError, item.error, `${item.id} SDK result`);
    if (item.id === "bad-edit") assert.equal((await journal.snapshot()).records.length, 10, "Validation failure before actual write must not own an effect");
  }
  assert.equal(await readFile(join(cwd, "data.txt"), "utf8"), "after");
  assert.equal(await readFile(join(cwd, "operator file.json"), "utf8"), "fake-auth");
  assert.equal(await readFile(join(cwd, "operator’s.json"), "utf8"), "fake-auth");
  await assert.rejects(readFile(join(path, "never-created")), { code: "ENOENT" });
  await assert.rejects(readFile(join(cwd, "blocked.txt")), { code: "ENOENT" });
  const snapshot = await journal.snapshot();
  assert.equal(snapshot.records.length, 13);
  assert.equal(snapshot.state.files.size, 7);
  assert.equal([...snapshot.state.files.values()].filter(effect => effect.phase.kind === "adopted").length, 6);
  await writeFile(join(path, "result.json"), JSON.stringify({ verdict: "actual-sdk-file-wrapper-component-only", actualSdkCalls: cases.length + rounds.flatMap(round => round.calls).length, realFileWrites: 6, writeAndEditRoundsSerialized: true, invalidEditCreatedNoEffect: true, protectedNormalizationAndReadFallbackRefused: true, aliasesRefused: true, unresolvedFreshMutationRefused: true, recoveredMutationTested: false, sourceGrantOwnerImplemented: false, hostIntegrated: false, commandRan: false }, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ event: "pass", proof: "execution-files", path, verdict: "actual-sdk-file-wrapper-component-only" }));
} catch (error) { failures.push(error); }
try { await owner?.close(); } catch (error) { failures.push(error); }
try { await journal?.close(); } catch (error) { failures.push(error); }
try { db.close(); } catch (error) { failures.push(error); }
try { await lease.close(); } catch (error) { failures.push(error); }
if (failures.length) throw new AggregateError(failures, "SDK file wrapper proof or cleanup failed");
