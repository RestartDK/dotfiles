import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProviderDoc, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { loadPolicy, resolveRoute } from "../../../config/pi/agent/lib/model-policy.ts";
import { CodingWorkspaceOwner } from "#coding-workspace";

type Phase = "initial" | "continue";

async function phase(root: string, step: Phase): Promise<void> {
  const policy = loadPolicy();
  const target = resolveRoute(policy, { role: "precise-code" }).chain[0];
  const models = await ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsStorePath: join(root, "models-store.json"),
  });
  const selected = models.getModel(target.provider, target.id);
  assert.ok(selected, "The exact policy model must exist; the proof has no fallback");
  const context = withAbortSignal(AbortSignal.timeout(150_000), BACKGROUND_CONTEXT);
  const owner = await CodingWorkspaceOwner.open({
    stateDirectory: join(root, "state"),
    workspace: {
      domain: policy.profile,
      nodeId: hostname(),
      workspaceId: basename(root),
      cwd: join(root, "worktree"),
    },
    execution: "trusted-user",
    lockCommand: { file: process.env.DSTACK_FLOCK || "flock", args: [] },
    models,
    model: { provider: target.provider, modelId: target.id },
  }, context);
  try {
    const provider = await owner.harness.snapshot(ProviderDoc, owner.conversation.id, context);
    assert.ok(provider);
    const identity = {
      profile: policy.profile,
      provider: target.provider,
      model: target.id,
      thinking: target.thinking,
      rootId: owner.conversation.id,
      providerSessionId: provider.sessionId,
    };
    const before = await owner.conversation.context(context);
    if (step === "continue") {
      const saved: unknown = JSON.parse(await readFile(join(root, "identity.json"), "utf8"));
      assert.deepEqual(identity, saved);
      assert.equal(before.entries.filter(UserEntry.is).length, 1);
      assert.ok(before.entries.filter(ToolResultEntry.is).length >= 2);
    } else {
      assert.equal(before.entries.filter(UserEntry.is).length, 0);
    }
    const agent = await owner.conversation.agent(context);
    await owner.conversation.configure({
      thinkingLevel: target.thinking,
      tools: agent.tools.filter((tool) => tool.name === "read" || tool.name === "write"),
      instructions: "Complete only the supplied temporary-file task with the read and write tools.",
    }, context);
    const content = step === "initial"
      ? 'Use write to create live.txt containing exactly "first-live-turn\\n". Then use read to verify it. Reply FIRST_DONE after both succeed.'
      : 'Continue our previous work. Use read to check live.txt contains "first-live-turn\\n". Use write to replace it with exactly "first-live-turn\\nsecond-live-turn\\n", then read it again. Reply SECOND_DONE after these tools succeed.';
    const draft = {
      type: "input",
      content,
      requestId: `live-${step}`,
    } satisfies Parameters<typeof owner.conversation.submit>[0];
    const submission = await owner.conversation.submit(draft, context);
    const receipt = await submission.wait(context);
    assert.ok(receipt);
    assert.equal(receipt.status, "done");
    const expected = step === "initial"
      ? "first-live-turn\n"
      : "first-live-turn\nsecond-live-turn\n";
    const transcript = await owner.conversation.context(context);
    assert.equal(transcript.entries.filter(UserEntry.is).length, step === "initial" ? 1 : 2);
    const results = transcript.messages.filter((message) => message.role === "toolResult");
    assert.ok(results.length >= (step === "initial" ? 2 : 5));
    assert.ok(results.every((message) => !message.isError));
    const lastRead = results.findLast((message) => message.toolName === "read");
    assert.ok(lastRead?.content.some(
      (block) => block.type === "text" && block.text.includes(expected.trim()),
    ));
    const answers = transcript.messages.filter((message) => message.role === "assistant");
    assert.ok(answers.length > 0);
    for (const answer of answers) {
      assert.equal(answer.provider, target.provider);
      assert.equal(answer.model, target.id);
      assert.notEqual(answer.stopReason, "error", answer.errorMessage);
      assert.notEqual(answer.stopReason, "aborted", answer.errorMessage);
    }
    assert.equal(await readFile(join(owner.workspace.cwd, "live.txt"), "utf8"), expected);
    const duplicate = await owner.conversation.submit(draft, context);
    assert.equal(duplicate.id, submission.id);
    assert.deepEqual(await duplicate.wait(context), receipt);
    if (step === "initial")
      await writeFile(join(root, "identity.json"), JSON.stringify(identity), { mode: 0o600 });
    const summary = {
      event: "pass",
      proof: "live-conversation",
      phase: step,
      root,
      ownerPid: process.pid,
      databasePath: owner.databasePath,
      ...identity,
      api: selected.api,
      submissionId: submission.id,
      modelRequestsTotal: answers.length,
      toolResultsTotal: results.length,
    };
    await writeFile(join(root, `${step}.json`), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(summary));
  } finally {
    await owner.close();
  }
}

async function runPhase(root: string, step: Phase): Promise<void> {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "phase", root, step], {
    stdio: "inherit",
    signal: AbortSignal.timeout(180_000),
    killSignal: "SIGKILL",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Live ${step} process failed (${code}, ${signal})`));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "phase") {
    const root = process.argv[3];
    const step = process.argv[4];
    assert.ok(root);
    assert.ok(step === "initial" || step === "continue");
    await phase(root, step);
  } else {
    assert.equal(process.argv[2], undefined, "The live proof takes no arguments");
    const root = await realpath(await mkdtemp(join(tmpdir(), "dstack-conversation-live-")));
    await mkdir(join(root, "worktree"), { mode: 0o700 });
    execFileSync("git", ["init", "--quiet", join(root, "worktree")], {
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TEMPLATE_DIR: "",
      },
    });
    console.log(JSON.stringify({ event: "fixture", proof: "live-conversation", root }));
    await runPhase(root, "initial");
    await runPhase(root, "continue");
    console.log(JSON.stringify({ event: "pass", proof: "live-conversation-restart", root }));
  }
}
