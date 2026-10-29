import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, hook, ToolTask, wrapTool, type TaskId } from "@earendil-works/pi-durable";
import { createWriteTool } from "@earendil-works/pi-durable/tools";
import { CodingWorkspaceOwner } from "#coding-workspace";
import { CommandDirectory } from "#command-store";
import { ExecutionJournal } from "#execution-journal";
import { executionDigest } from "#execution-wire";
import { executionFileTools } from "#execution-files";
import { WorkspacePaths } from "#workspace-paths";
import { unresolvedEffects } from "#execution-domain";

type Guard = "actual-wrapper" | "before-tool-only";

async function recovery(guard: Guard) {
  const path = await mkdtemp(join(tmpdir(), "dstack-file-recovery-"));
  const cwd = join(path, "workspace"), evidence = join(path, "evidence");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(evidence, { mode: 0o700 });
  const databasePath = join(path, "host.sqlite");
  const file = await open(databasePath, "wx", 0o600); await file.close();
  const db = new DatabaseSync(databasePath); db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  const lease = await CommandDirectory.own({ path: evidence, lockCommand: { file: process.env.DSTACK_FLOCK || "flock", args: [] } });
  const workspace = { domain: "personal", nodeId: "recovery-fixture", workspaceId: "files", cwd } satisfies Parameters<typeof CodingWorkspaceOwner.open>[0]["workspace"];
  let journal: ExecutionJournal | undefined;
  let owner: CodingWorkspaceOwner | undefined;
  const failures: unknown[] = [];
  let result: { path: string; guard: Guard; beforeToolCalls: number; recoveredOriginalTaskId: number; trustedChangePreserved: boolean; actualProcessKill: boolean } | undefined;
  try {
    journal = await ExecutionJournal.initialize({ db, directory: lease.directory, root: { version: 1, rootId: randomUUID(), token: randomBytes(32).toString("hex"), workspace }, maxRecords: 32 });
    const activeJournal = journal;
    const paths = await WorkspacePaths.open({ cwd, protectedPaths: [evidence, join(path, "coding")] });
    const ready = Promise.withResolvers<TaskId>();
    let phase: "initial" | "reopened" = "initial";
    let beforeToolCalls = 0;
    const registry = createRegistry();
    registry.install(guard === "actual-wrapper" ? executionFileTools({ journal, paths }) : defineExtension({ name: "fixture-before-only-files", tools: [createWriteTool()] }));
    registry.install(defineExtension({
      name: "fixture-safe-recovery",
      wraps: [wrapTool(createWriteTool(), tool => ({
        ...tool, replay: "safe",
        async execute(args, api, context) {
          const value = await tool.execute(args, api, context);
          if (phase === "initial") {
            ready.resolve(api.taskId);
            await awaitWithContext(new Promise<never>(() => {}), context);
          }
          return value;
        },
      }))],
      hooks: [hook(ToolTask, { async beforeTool() {
        beforeToolCalls++;
        if (unresolvedEffects((await activeJournal.snapshot()).state).length !== 0) return { block: "Unresolved fixture effect" };
        return undefined;
      } })],
    }));
    function runtime(stage: "initial" | "reopened") {
      const faux = fauxProvider({ api: "file-recovery-fixture", provider: "file-recovery-fixture", models: [{ id: "files", input: ["text"] }], tokenSize: { min: 4096, max: 4096 } });
      faux.setResponses(stage === "reopened" ? [fauxAssistantMessage("recovered")] : [fauxAssistantMessage(fauxToolCall("write", { path: "effect.txt", content: "original" }, { id: "recover-write" }), { stopReason: "toolUse" })]);
      const models = createModels(); models.setProvider(faux.provider); const model = faux.getModel();
      return { stateDirectory: join(path, "coding"), workspace, models, model: { provider: model.provider, modelId: model.id }, execution: "trusted-user", lockCommand: { file: process.env.DSTACK_FLOCK || "flock", args: [] }, registry } satisfies Parameters<typeof CodingWorkspaceOwner.open>[0];
    }
    const context = withAbortSignal(AbortSignal.timeout(20_000), BACKGROUND_CONTEXT);
    owner = await CodingWorkspaceOwner.open(runtime("initial"), context);
    const submission = await owner.conversation.submit({ type: "input", requestId: "recover", content: "Fixture write and pause before its SDK result." }, context);
    const taskId = await awaitWithContext(ready.promise, context);
    const task = await owner.harness.getTask(taskId, context);
    assert.ok(task?.state.status === "running");
    const checkpoint = task.state.checkpoint;
    assert.ok(typeof checkpoint === "object" && checkpoint !== null && "phase" in checkpoint && checkpoint.phase === "execute" && "replay" in checkpoint && checkpoint.replay === "safe");
    assert.equal(await readFile(join(cwd, "effect.txt"), "utf8"), "original");
    await owner.close(); owner = undefined;
    await writeFile(join(cwd, "effect.txt"), "trusted-change");
    await journal.append({ kind: "file.started", effectId: executionDigest("unresolved-after-detach"), tool: "write", path: join(cwd, "never-written"), argumentsSha256: executionDigest("synthetic"), sdk: { taskKey: "synthetic", conversationKey: "synthetic", callId: "synthetic" } });
    phase = "reopened";
    owner = await CodingWorkspaceOwner.open(runtime("reopened"), context);
    await owner.conversation.waitForIdle(context);
    const recovered = await owner.harness.getTask(taskId, context);
    assert.ok(recovered?.state.status === "terminal");
    assert.equal(beforeToolCalls, 1, "SDK execute-phase recovery must bypass beforeTool");
    assert.equal((await owner.conversation.submit({ type: "input", requestId: "recover", content: "Fixture write and pause before its SDK result." }, context)).id, submission.id);
    result = { path, guard, beforeToolCalls, recoveredOriginalTaskId: taskId, trustedChangePreserved: await readFile(join(cwd, "effect.txt"), "utf8") === "trusted-change", actualProcessKill: false };
    await writeFile(join(path, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  } catch (error) { failures.push(error); }
  try { await owner?.close(); } catch (error) { failures.push(error); }
  try { await journal?.close(); } catch (error) { failures.push(error); }
  try { db.close(); } catch (error) { failures.push(error); }
  try { await lease.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Recovered SDK file wrapper proof or cleanup failed");
  assert.ok(result);
  return result;
}

const baseline = await recovery("before-tool-only");
assert.equal(baseline.trustedChangePreserved, false, "The same SDK recovery must expose the beforeTool-only gap");
const guarded = await recovery("actual-wrapper");
assert.equal(guarded.trustedChangePreserved, true, "The actual execution wrapper must prevent recovered mutation");
console.log(JSON.stringify({ event: "pass", proof: "execution-files-recovery", baseline, guarded, verdict: "actual-sdk-recovery-wrapper-component-only", productionReplayChanged: false, commandRan: false, hostIntegrated: false }));
