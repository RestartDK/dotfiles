import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { DurableHost } from "#durable-host";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import {
  frames,
  MAX_FRAME_BYTES,
  parseHostConfig,
  parseOperation,
  type HostIdentity,
} from "#host-protocol";

const root = await mkdtemp(join(tmpdir(), "dstack-host-"));
const cwd = join(root, "worktree");
await mkdir(cwd);
const config = {
  identity: { deploymentId: "host-proof", domain: "work", nodeId: "isolated-node" },
  stateRoot: join(root, "state"),
  model: { provider: "host-fixture", modelId: "files" },
  thinkingLevel: "off",
  authPath: join(root, "auth.json"),
  modelsPath: join(root, "models.json"),
};
const configPath = join(root, "config.json");
await writeFile(configPath, JSON.stringify(config));
console.log(JSON.stringify({ event: "fixture", root }));

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

const padded = parseOperation({ op: "snapshot", workspaceId: " padded " });
assert.ok(padded.op === "snapshot");
assert.equal(padded.workspaceId, " padded ");
assert.throws(() => parseHostConfig({ ...config, identity: { ...config.identity, nodeId: " " } }));
assert.throws(() => parseHostConfig({ ...config, thinkingLevel: "unsupported" }));

async function start(mode = "normal") {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./host-fixture.js", import.meta.url)), configPath, mode],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString();
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
  void exit.finally(() => clearTimeout(deadline));
  const reader = frames(child.stdout);
  const ready = record((await reader.next()).value);
  assert.equal(ready.type, "ready", errors);
  assert.equal(ready.v, 1);
  assert.equal(ready.maxFrameBytes, MAX_FRAME_BYTES);
  assert.deepEqual(ready.identity, config.identity);
  assert.deepEqual(ready.tools, ["read", "write", "edit"]);
  let id = 0;
  return {
    child,
    exit,
    ready,
    async call(operation: unknown) {
      const key = String(++id);
      child.stdin.write(`${JSON.stringify({ v: 1, id: key, operation })}\n`);
      const response = record((await reader.next()).value);
      assert.equal(response.id, key);
      return response;
    },
    async close() {
      child.stdin.end();
      assert.equal(await exit, 0, errors);
    },
  };
}

const first = await start();
const created = record(
  (await first.call({ op: "create", requestId: "create", workspaceId: "w1", cwd })).result,
);
const submit = parseOperation({
  op: "submit",
  workspaceId: "w1",
  requestId: "turn1",
  content: "Write a file",
});
let submitted = record((await first.call(submit)).result);
assert.equal(submitted.conversationId, created.conversationId);
for (let i = 0; i < 100; i++) {
  const status = record(
    (await first.call({ op: "status", workspaceId: "w1", requestId: "turn1" })).result,
  );
  if (record(status.receipt).status === "done") {
    submitted = status;
    break;
  }
  await delay(20);
}
assert.equal(record(submitted.receipt).status, "done");
assert.equal(await readFile(join(cwd, "proof.txt"), "utf8"), "host-owned\n");
const conflict = await first.call({ ...submit, content: "Different effect" });
assert.equal(record(conflict.error).code, "request_conflict");
const other = join(root, "other");
await mkdir(other);
assert.equal(
  record(
    (await first.call({ op: "create", requestId: "retarget", workspaceId: "w1", cwd: other }))
      .error,
  ).code,
  "binding_mismatch",
);
await first.close();
const second = await start();
assert.notEqual(second.ready.bootId, first.ready.bootId);
assert.deepEqual(record((await second.call(submit)).result).receipt, submitted.receipt);
const snapshot = record((await second.call({ op: "snapshot", workspaceId: "w1" })).result);
assert.equal(record(snapshot.workspace).conversationId, created.conversationId);
assert.ok(Array.isArray(snapshot.entries));
assert.equal(snapshot.entries.filter((entry) => record(entry).kind === "pi.user").length, 1);
await second.close();

const db = new DatabaseSync(join(config.stateRoot, "host.sqlite"));
db.prepare("UPDATE admissions SET admitted=0 WHERE id='turn1'").run();
db.close();
const reconcile = await start();
assert.deepEqual(
  record((await reconcile.call({ op: "status", workspaceId: "w1", requestId: "turn1" })).result)
    .receipt,
  submitted.receipt,
);
await reconcile.close();

for (const mode of ["admission-crash", "ack-crash"]) {
  const crash = await start(mode);
  crash.child.stdin.write(
    `${JSON.stringify({ v: 1, id: "crash", operation: { ...submit, requestId: mode } })}\n`,
  );
  assert.equal(await crash.exit, null);
  const recovered = await start();
  let receipt: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) {
    const status = record(
      (await recovered.call({ op: "status", workspaceId: "w1", requestId: mode })).result,
    );
    receipt = record(status.receipt);
    if (receipt.status === "done") break;
    await delay(20);
  }
  assert.equal(receipt.status, "done");
  assert.deepEqual(
    record((await recovered.call({ ...submit, requestId: mode })).result).receipt,
    receipt,
  );
  await recovered.close();
}
const alias = join(root, "cwd-alias");
await symlink(cwd, alias);
const createCrash = await start("create-crash");
const creation = parseOperation({
  op: "create",
  requestId: "create-crash",
  workspaceId: "alias",
  cwd: alias,
});
createCrash.child.stdin.write(
  `${JSON.stringify({ v: 1, id: "create-crash", operation: creation })}\n`,
);
assert.equal(await createCrash.exit, null);
await rename(alias, join(root, "original-cwd-alias"));
await symlink(other, alias);
const creationRecovered = await start();
assert.equal(record((await creationRecovered.call(creation)).result).cwd, cwd);
assert.equal(
  record((await creationRecovered.call({ ...creation, requestId: "cannot-retarget" })).error).code,
  "binding_mismatch",
);
await creationRecovered.close();

const joining = await start("join");
await joining.call({ ...submit, requestId: "join-model" });
for (let i = 0; i < 100; i++) {
  if (
    (await readFile(join(config.stateRoot, "model-started"), "utf8").catch(() => "")) === "started"
  )
    break;
  await delay(20);
}
assert.equal(
  record((await joining.call({ op: "snapshot", workspaceId: "" })).error).code,
  "invalid_request",
);
assert.ok(record((await joining.call({ op: "discover" })).result));
await assert.rejects(readFile(join(config.stateRoot, "model-joined"), "utf8"), { code: "ENOENT" });
await joining.close();
assert.equal(await readFile(join(config.stateRoot, "model-joined"), "utf8"), "joined");

for (const bytes of [
  Buffer.alloc(MAX_FRAME_BYTES + 1, 120),
  Buffer.from('{"v":1'),
  Buffer.from([0xff, 10]),
  Buffer.from('{"v":2,"id":"x","operation":{"op":"discover"}}\n'),
]) {
  const bad = await start();
  bad.child.stdin.end(bytes);
  assert.notEqual(await bad.exit, 0);
}
const final = await start();
assert.equal(
  record((await final.call({ op: "discover" })).result).workspaces instanceof Array,
  true,
);
await final.close();
const localModels = createModels();
const localProvider = fauxProvider({
  api: "host-fixture",
  provider: "host-fixture",
  models: [{ id: "files", input: ["text"] }],
});
localModels.setProvider(localProvider.provider);
const openingConfig = parseHostConfig({ ...config, stateRoot: join(root, "opening-state") });
const openingHost = await DurableHost.open(openingConfig, localModels);
const opening = openingHost.handle(parseOperation({
  op: "create",
  requestId: "create-during-eof",
  workspaceId: "new",
  cwd,
}));
await assert.rejects(openingHost.handle({ op: "discover" }), /in-flight/);
const closing = openingHost.close();
await assert.rejects(openingHost.handle({ op: "discover" }), /sealed/);
await opening;
await closing;
const identities: HostIdentity[] = [
  { ...openingConfig.identity, domain: "personal" },
  { ...openingConfig.identity, deploymentId: "other-deployment" },
  { ...openingConfig.identity, nodeId: "other-node" },
];
for (const identity of identities)
  await assert.rejects(
    DurableHost.open({ ...openingConfig, identity }, localModels),
    /Host root identity differs/,
  );
const afterOpening = await DurableHost.open(openingConfig, localModels);
assert.equal(
  record(await afterOpening.handle({ op: "discover" })).workspaces instanceof Array,
  true,
);
await afterOpening.close();
console.log(JSON.stringify({ event: "pass", proof: "host", root }));
