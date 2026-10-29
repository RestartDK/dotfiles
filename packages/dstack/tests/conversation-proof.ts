import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  ProviderDoc,
  ToolResultEntry,
  UserEntry,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import type { ReadToolInput, WriteToolInput } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingWorkspaceDoc, CodingWorkspaceOwner } from "#coding-workspace";
import {
  fixtureRuntime,
  parseRestartCheckpoint,
  type RestartCheckpoint,
  type RestartKind,
} from "./conversation-fixture.ts";

async function fixtureDirectory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dstack-conversation-")));
  const cwd = join(root, "worktree");
  await mkdir(cwd, { mode: 0o700 });
  execFileSync("git", ["init", "--quiet", cwd], {
    timeout: 5000,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TEMPLATE_DIR: "",
    },
  });
  return root;
}

function bounded<T>(promise: Promise<T>, label: string, milliseconds: number): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error(`${label} exceeded ${milliseconds}ms`)),
    milliseconds,
  );
  return Promise.race([promise, deadline.promise]).finally(() => clearTimeout(timer));
}

function toolResult(transcript: TranscriptContext, name: string) {
  const result = transcript.messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === name,
  );
  assert.ok(result && result.role === "toolResult", `Model did not receive the ${name} result`);
  return result;
}

async function assertSqliteTranscript(databasePath: string, resultCount: number): Promise<void> {
  const bytes = await readFile(databasePath);
  assert.equal(bytes.subarray(0, 16).toString("utf8"), "SQLite format 3\u0000");
  const info = await lstat(databasePath);
  assert.equal(info.mode & 0o077, 0);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      "SELECT count(*) AS total FROM entries WHERE json_extract(record, '$.kind') = ?",
    ).get(ToolResultEntry.kind);
    assert.equal(row?.total, resultCount);
    const integrity = database.prepare("PRAGMA integrity_check").get();
    assert.equal(integrity?.integrity_check, "ok");
  } finally {
    database.close();
  }
}

async function integrationProof(): Promise<void> {
  const transaction = NodeSqliteDatabase.prototype.transaction;
  let verifiedSqliteTransactions = 0;
  NodeSqliteDatabase.prototype.transaction = async function<T>(this: NodeSqliteDatabase, callback: (executor: SqliteExecutor) => Promise<T>): Promise<T> {
    const journal = await this.get<{ journal_mode: unknown }>("PRAGMA journal_mode");
    const synchronization = await this.get<{ synchronous: unknown }>("PRAGMA synchronous");
    assert.equal(journal?.journal_mode, "wal");
    assert.ok(synchronization?.synchronous === 2 || synchronization?.synchronous === 3, "Every actual SDK transaction requires FULL SQLite synchronization");
    verifiedSqliteTransactions++;
    return transaction.bind(this)(callback);
  };
  try {
  const root = await fixtureDirectory();
  console.log(JSON.stringify({ event: "fixture", proof: "integration", root }));
  const context = withAbortSignal(AbortSignal.timeout(25_000), BACKGROUND_CONTEXT);
  const sessions: string[] = [];
  const runtime = fixtureRuntime(root, [
    (_transcript, options) => {
      assert.ok(options?.sessionId);
      sessions.push(options.sessionId);
      return fauxAssistantMessage(fauxToolCall("write", {
        path: "artifact.txt",
        content: "persisted coding work\n",
      } satisfies WriteToolInput, { id: "write-artifact" }), { stopReason: "toolUse" });
    },
    (transcript, options) => {
      assert.equal(toolResult(transcript, "write").isError, false);
      assert.ok(options?.sessionId);
      sessions.push(options.sessionId);
      return fauxAssistantMessage(fauxToolCall("read", {
        path: "artifact.txt",
      } satisfies ReadToolInput, { id: "read-artifact" }), { stopReason: "toolUse" });
    },
    (transcript, options) => {
      const result = toolResult(transcript, "read");
      assert.equal(result.isError, false);
      assert.ok(result.content.some(
        (block) => block.type === "text" && block.text.includes("persisted coding work"),
      ));
      assert.ok(options?.sessionId);
      sessions.push(options.sessionId);
      return fauxAssistantMessage("Coding work completed.");
    },
  ]);
  const owner = await CodingWorkspaceOwner.open(runtime.options, context);
  const rootId = owner.conversation.id;
  const provider = await owner.harness.snapshot(ProviderDoc, rootId, context);
  assert.ok(provider);
  const request = {
    type: "input",
    content: "Write and read the artifact.",
    requestId: "completed-coding-work",
  } satisfies Parameters<typeof owner.conversation.submit>[0];
  let receipt: SettledSubmissionRecord | null = null;
  try {
    const binding = await owner.harness.snapshot(CodingWorkspaceDoc, context);
    assert.deepEqual(binding?.workspace, owner.workspace);
    assert.ok(Object.isFrozen(owner.workspace));
    const agent = await owner.conversation.agent(context);
    assert.deepEqual(
      agent.tools.map((tool) => tool.name).sort(),
      ["bash", "edit", "read", "write"],
    );
    await assert.rejects(CodingWorkspaceOwner.open(runtime.options, context), /Another daemon owns/);
    const submission = await owner.conversation.submit(request, context);
    receipt = await submission.wait(context);
    assert.ok(receipt);
    assert.equal(receipt.status, "done");
    assert.equal(receipt.type, "input");
    assert.equal(runtime.faux.state.callCount, 3);
    assert.deepEqual(sessions, [provider.sessionId, provider.sessionId, provider.sessionId]);
    assert.equal(
      await readFile(join(root, "worktree/artifact.txt"), "utf8"),
      "persisted coding work\n",
    );
  } finally {
    const closing = owner.close();
    assert.equal(owner.close(), closing);
    await closing;
  }
  assert.ok(receipt);
  await assertSqliteTranscript(owner.databasePath, 2);
  const other = join(root, "other-worktree");
  await mkdir(other, { mode: 0o700 });
  for (const workspace of [
    { ...runtime.options.workspace, domain: "work" } satisfies typeof runtime.options.workspace,
    { ...runtime.options.workspace, nodeId: "another-node" },
    { ...runtime.options.workspace, workspaceId: "another-workspace" },
    { ...runtime.options.workspace, cwd: other },
  ])
    await assert.rejects(
      CodingWorkspaceOwner.open({ ...runtime.options, workspace }, context),
      /binding mismatch/,
    );
  const alias = join(root, "worktree-alias");
  await symlink(runtime.options.workspace.cwd, alias, "dir");
  const reopenedRuntime = fixtureRuntime(root, []);
  const reopened = await CodingWorkspaceOwner.open({
    ...reopenedRuntime.options,
    workspace: { ...reopenedRuntime.options.workspace, cwd: alias },
  }, context);
  try {
    assert.equal(reopened.conversation.id, rootId);
    assert.deepEqual(await reopened.harness.snapshot(ProviderDoc, rootId, context), provider);
    assert.equal(reopened.workspace.cwd, runtime.options.workspace.cwd);
    const again = await reopened.conversation.submit(request, context);
    assert.equal(again.id, receipt.id);
    assert.deepEqual(await again.wait(context), receipt);
    const transcript = await reopened.conversation.context(context);
    assert.equal(transcript.entries.filter(UserEntry.is).length, 1);
    assert.equal(transcript.entries.filter(ToolResultEntry.is).length, 2);
    assert.equal(reopenedRuntime.faux.state.callCount, 0);
    reopenedRuntime.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", {
        path: "retarget.txt",
        content: "must not be written",
      } satisfies WriteToolInput, { id: "retarget-write" }), { stopReason: "toolUse" }),
      (input) => {
        assert.equal(toolResult(input, "write").isError, true);
        return fauxAssistantMessage("Retargeted execution was rejected.");
      },
    ]);
    await reopened.conversation.configure({ cwd: other }, context);
    const denied = await reopened.conversation.submit({
      type: "input",
      content: "Cannot retarget the execution environment.",
      requestId: "retarget-denied",
    }, context);
    assert.equal((await denied.wait(context)).status, "done");
    await assert.rejects(readFile(join(other, "retarget.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(join(reopened.workspace.cwd, "retarget.txt")), { code: "ENOENT" });
    await reopened.conversation.configure({ cwd: reopened.workspace.cwd }, context);
  } finally {
    await reopened.close();
  }
  const publicDirectory = join(root, "public-state");
  await mkdir(publicDirectory);
  await chmod(publicDirectory, 0o755);
  await assert.rejects(
    CodingWorkspaceOwner.open({ ...runtime.options, stateDirectory: publicDirectory }, context),
    /must be private/,
  );
  const jobsDirectory = join(root, "jobs-state");
  await mkdir(jobsDirectory, { mode: 0o700 });
  await writeFile(join(jobsDirectory, "jobs.sqlite"), "isolated fixture sentinel");
  await assert.rejects(
    CodingWorkspaceOwner.open({ ...runtime.options, stateDirectory: jobsDirectory }, context),
    /separate from jobs.sqlite/,
  );
  const linkedDirectory = join(root, "linked-state");
  const linkedTarget = join(root, "linked-target");
  await mkdir(linkedDirectory, { mode: 0o700 });
  await writeFile(linkedTarget, "isolated hard-link sentinel", { mode: 0o600 });
  await link(linkedTarget, join(linkedDirectory, "conversation.sqlite"));
  await assert.rejects(
    CodingWorkspaceOwner.open({ ...runtime.options, stateDirectory: linkedDirectory }, context),
    /must not have hard-linked aliases/,
  );
  assert.equal(await readFile(linkedTarget, "utf8"), "isolated hard-link sentinel");
  assert.ok(verifiedSqliteTransactions > 0);
  const summary = {
    event: "pass",
    proof: "integration",
    root,
    databasePath: owner.databasePath,
    rootId,
    providerSessionId: provider.sessionId,
    submissionId: receipt.id,
    verifiedSqliteTransactions,
  };
  await writeFile(join(root, "proof.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
  } finally { NodeSqliteDatabase.prototype.transaction = transaction; }
}

async function closeFailureProof(): Promise<void> {
  const root = await fixtureDirectory();
  const runtime = fixtureRuntime(root, []);
  const owner = await CodingWorkspaceOwner.open(runtime.options, BACKGROUND_CONTEXT);
  const rootId = owner.conversation.id;
  const originalExec = DatabaseSync.prototype.exec;
  const originalCleanup = NodeExecutionEnv.prototype.cleanup;
  const fault = new Error("Injected checkpoint failure after quiescence");
  const observed: { database: DatabaseSync | null; cleanups: number } = {
    database: null,
    cleanups: 0,
  };
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === "PRAGMA wal_checkpoint(TRUNCATE)") {
      observed.database = this;
      throw fault;
    }
    originalExec.call(this, sql);
  };
  NodeExecutionEnv.prototype.cleanup = async function (context) {
    observed.cleanups++;
    await originalCleanup.call(this, context);
  };
  try {
    const closing = owner.close();
    await assert.rejects(closing, (error: unknown) => error === fault);
    assert.equal(owner.close(), closing);
    assert.equal(observed.database?.isOpen, false);
    assert.equal(observed.cleanups, 1);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    NodeExecutionEnv.prototype.cleanup = originalCleanup;
  }
  const reopened = await CodingWorkspaceOwner.open(runtime.options, BACKGROUND_CONTEXT);
  try {
    assert.equal(reopened.conversation.id, rootId);
  } finally {
    await reopened.close();
  }
  const summary = { event: "pass", proof: "close-failure", root, rootId };
  await writeFile(join(root, "proof.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
}

async function modelReopenProof(): Promise<void> {
  const root = await fixtureDirectory();
  const runtime = fixtureRuntime(root, []);
  const next = fauxProvider({
    provider: "next-coding-fixture",
    api: "next-coding-fixture",
    models: [{ id: "next", input: ["text"] }],
  });
  const nextModel = next.getModel();
  const reference = { provider: nextModel.provider, modelId: nextModel.id };
  const both = createModels();
  both.setProvider(runtime.faux.provider);
  both.setProvider(next.provider);
  const owner = await CodingWorkspaceOwner.open({
    ...runtime.options,
    models: both,
    initialThinkingLevel: "xhigh",
  }, BACKGROUND_CONTEXT);
  const rootId = owner.conversation.id;
  const provider = await owner.harness.snapshot(ProviderDoc, rootId, BACKGROUND_CONTEXT);
  try {
    assert.equal((await owner.conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel, "xhigh");
    await owner.conversation.configure({ model: reference, thinkingLevel: "high" }, BACKGROUND_CONTEXT);
  } finally {
    await owner.close();
  }
  const onlyNext = createModels();
  onlyNext.setProvider(next.provider);
  const reopened = await CodingWorkspaceOwner.open({
    ...runtime.options,
    models: onlyNext,
    initialThinkingLevel: "off",
  }, BACKGROUND_CONTEXT);
  try {
    assert.equal(reopened.conversation.id, rootId);
    assert.deepEqual((await reopened.conversation.agent(BACKGROUND_CONTEXT)).model, reference);
    assert.equal((await reopened.conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel, "high");
    assert.deepEqual(await reopened.harness.snapshot(ProviderDoc, rootId, BACKGROUND_CONTEXT), provider);
  } finally {
    await reopened.close();
  }
  await assert.rejects(
    CodingWorkspaceOwner.open(runtime.options, BACKGROUND_CONTEXT),
    /Stored coding model is not installed/,
  );
  const invalidDirectory = join(root, "invalid-model-state");
  await assert.rejects(CodingWorkspaceOwner.open({
    ...runtime.options,
    stateDirectory: invalidDirectory,
    models: onlyNext,
  }, BACKGROUND_CONTEXT), /Coding model is not installed/);
  const database = new DatabaseSync(join(invalidDirectory, "conversation.sqlite"), { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT count(*) AS total FROM conversations").get()?.total, 0);
  } finally {
    database.close();
  }
  const valid = await CodingWorkspaceOwner.open({
    ...runtime.options,
    stateDirectory: invalidDirectory,
  }, BACKGROUND_CONTEXT);
  try {
    assert.deepEqual((await valid.conversation.agent(BACKGROUND_CONTEXT)).model, runtime.options.model);
    assert.equal((await valid.conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel, "off");
  } finally {
    await valid.close();
  }
  assert.equal(runtime.faux.state.callCount, 0);
  assert.equal(next.state.callCount, 0);
  const summary = { event: "pass", proof: "model-reopen", root, rootId };
  await writeFile(join(root, "proof.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
}

function assertCommittedCheckpoint(databasePath: string, checkpoint: RestartCheckpoint): void {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("SELECT record FROM tasks WHERE id = ?").get(checkpoint.taskId);
    assert.equal(typeof row?.record, "string");
    assert.ok(row && typeof row.record === "string");
    const saved: unknown = JSON.parse(row.record);
    assert.ok(typeof saved === "object" && saved !== null && "state" in saved);
    const state = saved.state;
    assert.ok(
      typeof state === "object" && state !== null &&
      "status" in state && "checkpoint" in state,
    );
    assert.equal(state.status, "running");
    const phase = state.checkpoint;
    assert.ok(typeof phase === "object" && phase !== null && "phase" in phase);
    assert.equal(phase.phase, checkpoint.phase);
    if (checkpoint.kind === "unsafe-tool") {
      assert.ok("replay" in phase);
      assert.equal(phase.replay, "unsafe");
    }
    const submission = database.prepare(
      "SELECT status FROM submissions WHERE id = ?",
    ).get(checkpoint.submissionId);
    assert.equal(submission?.status, "placed");
  } finally {
    database.close();
  }
}

async function killToolGroup(root: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(root, "worktree/tool.pid"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  assert.match(text, /^[1-9]\d*\n$/);
  const pid = Number(text.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function restartProof(kind: RestartKind): Promise<void> {
  const root = await fixtureDirectory();
  const databasePath = join(root, "state/conversation.sqlite");
  console.log(JSON.stringify({ event: "fixture", proof: kind, root, databasePath }));
  const context = withAbortSignal(AbortSignal.timeout(25_000), BACKGROUND_CONTEXT);
  const fixture = fileURLToPath(new URL("./conversation-fixture.js", import.meta.url));
  const child = spawn(process.execPath, [fixture, "worker", kind, root], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const ready = Promise.withResolvers<RestartCheckpoint>();
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  let log = "";
  let toolCleaned = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    log = (log + chunk.toString("utf8")).slice(-65_536);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log = (log + chunk.toString("utf8")).slice(-65_536);
  });
  child.once("error", (error) => {
    ready.reject(error);
    exited.reject(error);
  });
  child.once("close", (code, signal) => {
    ready.reject(new Error(`Fixture exited before checkpoint (${code}, ${signal})\n${log}`));
    exited.resolve({ code, signal });
  });
  child.once("message", (message: unknown) => {
    try {
      ready.resolve(parseRestartCheckpoint(message));
    } catch (error) {
      ready.reject(error);
    }
  });
  void exited.promise.catch(() => undefined);
  try {
    const checkpoint = await bounded(ready.promise, "Fixture checkpoint", 15_000);
    assert.equal(checkpoint.kind, kind);
    assertCommittedCheckpoint(databasePath, checkpoint);
    console.log(JSON.stringify({ event: "committed-checkpoint", root, databasePath, ...checkpoint }));
    const contender = fixtureRuntime(root, []);
    await assert.rejects(CodingWorkspaceOwner.open(contender.options, context), /Another daemon owns/);
    if (checkpoint.kind === "unsafe-tool") {
      assert.equal(await readFile(join(root, "worktree/effects.txt"), "utf8"), "effect\n");
      const toolPid = Number((await readFile(join(root, "worktree/tool.pid"), "utf8")).trim());
      assert.equal(toolPid, checkpoint.toolPid);
    }
    assert.equal(child.kill("SIGKILL"), true);
    const exit = await bounded(exited.promise, "Fixture termination", 5000);
    assert.equal(exit.signal, "SIGKILL");
    if (kind === "unsafe-tool") {
      await killToolGroup(root);
      toolCleaned = true;
    }
    assertCommittedCheckpoint(databasePath, checkpoint);
    const mismatched = fixtureRuntime(root, []);
    await assert.rejects(CodingWorkspaceOwner.open({
      ...mismatched.options,
      workspace: { ...mismatched.options.workspace, domain: "work" },
    }, context), /binding mismatch/);
    assert.equal(mismatched.faux.state.callCount, 0);
    const runtime = fixtureRuntime(root, [(transcript, options) => {
      assert.equal(options?.sessionId, checkpoint.providerSessionId);
      if (kind === "unsafe-tool") {
        const result = toolResult(transcript, "bash");
        assert.equal(result.toolCallId, "unsafe-append");
        assert.equal(result.isError, true);
        assert.ok(result.content.some(
          (block) => block.type === "text" && block.text.includes("tool-checkpoint:"),
        ));
      } else {
        assert.ok(transcript.messages.some(
          (message) => message.role === "user" &&
            message.content === "Complete after the process restarts.",
        ));
      }
      return fauxAssistantMessage(`${kind} recovered.`);
    }]);
    const owner = await CodingWorkspaceOwner.open(runtime.options, context);
    try {
      assert.equal(owner.conversation.id, checkpoint.rootId);
      assert.equal(
        (await owner.harness.snapshot(ProviderDoc, owner.conversation.id, context))?.sessionId,
        checkpoint.providerSessionId,
      );
      const restored = await owner.conversation.submit({
        type: "input",
        content: kind === "generation"
          ? "Complete after the process restarts."
          : "Append one effect and wait for interruption.",
        requestId: kind === "generation" ? "restart-generation" : "restart-tool",
      }, context);
      assert.equal(restored.id, checkpoint.submissionId);
      const settled = await restored.wait(context);
      assert.equal(settled.status, "done");
      assert.equal(settled.type, "input");
      assert.equal(runtime.faux.state.callCount, 1);
      const tasks = await owner.harness.commit(
        (tx) => tx.scanTasks({ conversationId: owner.conversation.id }, 10),
        context,
      );
      const recoveredTask = tasks.items.find((task) => task.id === checkpoint.taskId);
      assert.ok(recoveredTask && recoveredTask.state.status === "terminal");
      assert.equal(
        recoveredTask.state.outcome.status,
        kind === "generation" ? "completed" : "failed",
      );
      const transcript = await owner.conversation.context(context);
      assert.equal(transcript.entries.filter(UserEntry.is).length, 1);
      assert.ok(transcript.messages.some((message) =>
        message.role === "assistant" && message.content.some(
          (block) => block.type === "text" && block.text === `${kind} recovered.`,
        ),
      ));
      if (kind === "unsafe-tool") {
        const results = transcript.entries.filter(ToolResultEntry.is);
        assert.equal(results.length, 1);
        assert.ok(results[0]?.data.diagnostics.some(
          (diagnostic) => diagnostic.code === "interrupted" && diagnostic.severity === "error",
        ));
        assert.equal(await readFile(join(root, "worktree/effects.txt"), "utf8"), "effect\n");
      }
    } finally {
      await owner.close();
    }
    await assertSqliteTranscript(databasePath, kind === "unsafe-tool" ? 1 : 0);
    const summary = { event: "pass", proof: kind, root, databasePath, ...checkpoint };
    await writeFile(join(root, "proof.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try {
      await bounded(exited.promise, "Fixture cleanup", 5000);
    } finally {
      if (kind === "unsafe-tool" && !toolCleaned) await killToolGroup(root);
      await writeFile(join(root, "fixture.log"), log);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] !== "worker") {
  const kind = process.argv[2] ?? "all";
  if (kind === "all" || kind === "integration") await integrationProof();
  if (kind === "all" || kind === "generation") await restartProof("generation");
  if (kind === "all" || kind === "unsafe-tool") await restartProof("unsafe-tool");
  if (kind === "all" || kind === "close-failure") await closeFailureProof();
  if (kind === "all" || kind === "model-reopen") await modelReopenProof();
  assert.ok(
    kind === "all" || kind === "integration" || kind === "generation" || kind === "unsafe-tool" ||
      kind === "close-failure" || kind === "model-reopen",
    "Unknown conversation proof",
  );
}
