import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Harness } from "@earendil-works/pi-durable";
import { DurableHost } from "#durable-host";
import { parseHostConfig, parseOperation } from "#host-protocol";
import { parseCommandSpec } from "#command-wire";
import { HOST_COMMAND_TASK } from "../src/host-command-task.js";
import { hostCommandRuntime } from "../src/host-runtime.js";

const requestedNode = process.env.DSTACK_TEST_NODE;
assert.ok(requestedNode !== undefined && requestedNode.startsWith("/nix/store/"), "Explicit production Node required");
const node = requestedNode;
const audit = join(await realpath(process.cwd()), ".audit");
await mkdir(audit, { recursive: true, mode: 0o700 });
function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

async function scenario(mode: "duplicate" | "conflict"): Promise<void> {
  const path = await mkdtemp(join(audit, `host-admission-${mode}-`));
  const cwd = join(path, "workspace"), stateRoot = join(path, "state"), finish = join(cwd, "finish");
  await mkdir(cwd, { mode: 0o700 });
  const config = parseHostConfig({
    identity: { deploymentId: "admission-proof", domain: "personal", nodeId: mode },
    stateRoot, model: { provider: "admission-fixture", modelId: "idle" }, thinkingLevel: "off",
    authPath: join(path, "auth.json"), modelsPath: join(path, "models.json"),
    execution: { mode: "durable", maxRecords: 128 },
  });
  const faux = fauxProvider({ api: "admission-fixture", provider: "admission-fixture", models: [{ id: "idle", input: ["text"] }] });
  let generations = 0;
  faux.setResponses([() => { generations++; throw new Error("Command admission must not infer"); }]);
  const models = createModels(); models.setProvider(faux.provider);
  const commands = await hostCommandRuntime();
  const open = Harness.open;
  let captured: Harness | undefined, resume: (() => void) | undefined, heldResumes = 0;
  Harness.open = async (storage, options, context) => {
    const harness = await open(storage, options, context);
    assert.equal(captured, undefined, "One actual SDK workspace expected");
    captured = harness; resume = harness.resume.bind(harness);
    harness.resume = () => { heldResumes++; };
    return harness;
  };
  let host: DurableHost | undefined;
  const failures: unknown[] = [], released = new Set<string>();
  const intents = mode === "duplicate" ? ["first"] : ["first", "second"];
  const authorizations = new Map<string, string>();
  const call = (op: "start" | "describe" | "inspect" | "adopt" | "cancel" | "release", intentId: string) => {
    assert.ok(host !== undefined);
    return host.command({ op, workspaceId: "coding", intentId });
  };
  async function adopt(intentId: string) {
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) {
      const command = object(await call("adopt", intentId));
      if (object(command.phase).kind === "adopted") return command;
      await delay(20);
    }
    throw new Error(`Original command adoption deadline: ${intentId}`);
  }
  try {
    host = await DurableHost.open(config, models, { commands });
    await host.handle(parseOperation({ op: "create", requestId: "create", workspaceId: "coding", cwd }));
    const script = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],process.argv[3],{flag:'wx',mode:384});const t=setInterval(()=>{if(fs.existsSync(process.argv[2]))clearInterval(t);},20);";
    for (const intentId of intents) {
      const authorized = object(await host.command({ op: "authorize", workspaceId: "coding", authorization: { intentId, argv: [node, "-e", script, join(cwd, intentId), finish, intentId], timeoutSeconds: 15 } }));
      const spec = object(authorized.authorization).specJson; assert.ok(typeof spec === "string");
      authorizations.set(intentId, spec);
    }
    const starts = [object(await call("start", "first")), object(await call("start", mode === "duplicate" ? "first" : "second"))];
    assert.notEqual(starts[0]?.taskKey, starts[1]?.taskKey, "Distinct real SDK tasks must be admitted");
    const harness = captured, run = resume; assert.ok(harness !== undefined && run !== undefined);
    const inspection = await harness.inspect(BACKGROUND_CONTEXT);
    assert.equal(inspection.scheduling, "paused");
    const pending = inspection.tasks.map(task => task.record).filter(task => task.kind === HOST_COMMAND_TASK);
    assert.equal(pending.length, 2);
    assert.deepEqual(pending.map(task => task.state.status), ["pending", "pending"]);
    assert.deepEqual(pending.map(task => String(task.id)).sort(), starts.map(task => String(task.taskKey)).sort());
    const before = object(await host.handle(parseOperation({ op: "execution.status", workspaceId: "coding" })));
    assert.equal(before.sequence, intents.length, "Only authorizations exist before actual SDK scheduling");
    assert.deepEqual(before.unresolved, []);
    assert.ok(heldResumes >= 2);
    harness.resume = run; run();
    const deadline = performance.now() + 20000;
    let settled = pending;
    for (;;) {
      settled = await Promise.all(pending.map(async task => {
        const current = await harness.getTask(task.id, BACKGROUND_CONTEXT); assert.ok(current !== undefined); return current;
      }));
      if (settled.every(task => task.state.status === "terminal")) break;
      if (performance.now() >= deadline) throw new Error("Owned SDK task terminalization deadline");
      await delay(20);
    }
    const completed = settled.filter(task => task.state.status === "terminal" && task.state.outcome.status === "completed");
    const faulted = settled.filter(task => task.state.status === "terminal" && task.state.outcome.status === "faulted");
    assert.equal(completed.length, mode === "duplicate" ? 2 : 1);
    assert.equal(faulted.length, mode === "duplicate" ? 0 : 1);
    if (mode === "conflict") {
      const rejected = faulted[0]; assert.ok(rejected?.state.status === "terminal");
      assert.match(JSON.stringify(rejected.state.outcome), /Unresolved execution effects block new mutations/);
    }
    const database = new DatabaseSync(join(stateRoot, "host.sqlite"), { readOnly: true });
    let winner: string;
    try {
      const records = database.prepare("SELECT record_json FROM herdr_execution_records ORDER BY sequence").all().map(row => object(JSON.parse(String(row.record_json))));
      const attempts = records.map(record => object(record.event)).filter(event => event.kind === "command.attempted");
      assert.equal(attempts.length, 1);
      const attempt = attempts[0]; assert.ok(attempt !== undefined && typeof attempt.intentId === "string"); winner = attempt.intentId;
      const sdk = object(attempt.sdk);
      const actual = completed.find(task => String(task.id) === sdk.taskKey); assert.ok(actual !== undefined);
      assert.deepEqual(sdk, { kind: "task", taskKey: String(actual.id), conversationKey: String(actual.conversationId) });
      assert.equal(records.length, intents.length + 2);
    } finally { database.close(); }
    await writeFile(finish, "finish", { flag: "wx", mode: 0o600 });
    await adopt(winner); await call("release", winner); released.add(winner);
    const specJson = authorizations.get(winner); assert.ok(specJson !== undefined);
    const spec = parseCommandSpec(specJson);
    const manager = process.env.DSTACK_SYSTEMCTL; assert.ok(manager !== undefined);
    const custody = spawnSync(manager, ["--user", "show", spec.unit, "--property=NFileDescriptorStore", "--value"], { encoding: "utf8", timeout: 5000 });
    assert.equal(custody.status, 0); assert.equal(custody.stdout.trim(), "0");
    assert.equal(await readFile(join(cwd, winner), "utf8"), winner);
    const revokedIntents = intents.filter(id => id !== winner);
    for (const intentId of revokedIntents) {
      await assert.rejects(readFile(join(cwd, intentId)), { code: "ENOENT" });
      const untouched = object(await call("describe", intentId));
      assert.equal(object(object(untouched.command).phase).kind, "authorized");
      assert.equal(untouched.grant, "live");
      await call("cancel", intentId);
      assert.equal(object(await call("describe", intentId)).grant, "revoked");
    }
    const final = object(await host.handle(parseOperation({ op: "execution.status", workspaceId: "coding" })));
    assert.equal(final.sequence, intents.length + 3 + revokedIntents.length);
    assert.deepEqual(final.unresolved, []);
    harness.resume(); await delay(20);
    for (const task of settled) assert.deepEqual((await harness.getTask(task.id, BACKGROUND_CONTEXT))?.state, task.state);
    assert.equal(generations, 0);
    const result = { path, mode, proof: "actual-sdk-command-admission-window", actualSdkTasks: pending.map(task => String(task.id)), twoTasksBeforeAnyAttempt: true, oneDurableAttempt: true, conflictingTaskTerminallyFaulted: mode === "conflict", duplicateTasksAttach: mode === "duplicate", originalCustodyReleased: true, providerGenerations: generations, modelCommandRegistered: false };
    await writeFile(join(path, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(result));
  } catch (error) { failures.push(error); }
  finally {
    Harness.open = open;
    try { await writeFile(finish, "finish", { mode: 0o600 }); } catch (error) { failures.push(error); }
    if (host !== undefined) {
      for (const intentId of authorizations.keys()) if (!released.has(intentId)) {
        try {
          const description = object(await call("describe", intentId));
          const phase = object(object(description.command).phase).kind;
          if (phase === "authorized") await call("cancel", intentId);
          else if (phase === "activated" || phase === "adopted") { await adopt(intentId); await call("release", intentId); }
          else throw new Error(`Retain unknown command during cleanup: ${intentId}/${String(phase)}`);
        } catch (error) { failures.push(error); }
      }
      try { await host.close(); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw new AggregateError(failures, `Admission proof or original-custody cleanup failed; preserve ${path}`);
}

await scenario("duplicate");
await scenario("conflict");
