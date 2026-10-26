import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { clientToken, newClientCredential } from "#client-authority";
import { ClientServer } from "#client-http";
import { DurableHost } from "#durable-host";
import { parseHostConfig, parseOperation } from "#host-protocol";
import { clientMessages } from "../src/client-reader.js";

const root = await mkdtemp(join(tmpdir(), "client-start-race-"));
process.stderr.write(`${JSON.stringify({ fixture: "client-start-race", root })}\n`);
const cwd = join(root, "workspace"); await mkdir(cwd, { mode: 0o700 });
const identity = { deploymentId: "client-start-race", domain: "personal", nodeId: "fixture" } satisfies Parameters<typeof newClientCredential>[0]["identity"];
const credential = newClientCredential({ identity, principalId: "reader" });
const tokenFile = join(root, "reader.key"); await writeFile(tokenFile, JSON.stringify(credential), { mode: 0o600, flag: "wx", flush: true });
const config = parseHostConfig({ identity, stateRoot: join(root, "state"), model: { provider: "client-start-race", modelId: "text" }, thinkingLevel: "off", authPath: join(root, "unused-auth"), modelsPath: join(root, "unused-models"), execution: { mode: "durable", maxRecords: 256, clients: { version: 1, listen: { host: "127.0.0.1", port: 0 }, workspaces: [{ workspaceId: "coding", cwd }], grants: [{ principalId: "reader", tokenFile, workspaces: [{ workspaceId: "coding", permissions: ["read"] }] }] } } });
const faux = fauxProvider({ api: "client-start-race", provider: "client-start-race", models: [{ id: "text", input: ["text"] }] });
const models = createModels(); models.setProvider(faux.provider);
const host = await DurableHost.open(config, models);
const descriptor = Object.getOwnPropertyDescriptor(ServerResponse.prototype, "write"), originalWrite = ServerResponse.prototype.write;
let closing: Promise<void> | undefined, triggered = false;
function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Baseline/start shutdown race did not drain")), 12000); })]).finally(() => clearTimeout(timer));
}
try {
  await host.handle(parseOperation({ op: "create", workspaceId: "coding", requestId: "trusted-fixture", cwd }));
  const ingress = await ClientServer.open(host);
  Object.defineProperty(ServerResponse.prototype, "write", { configurable: true, get(this: ServerResponse) {
    if (!triggered && this.getHeader("Content-Type") === "text/event-stream") {
      triggered = true;
      closing = host.close();
    }
    return originalWrite;
  } });
  const response = await fetch(`${ingress.endpoint}/v1`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${clientToken(credential)}` }, body: JSON.stringify({ v: 1, id: "baseline-race", operation: { op: "watch", workspaceId: "coding" } }) });
  assert.equal(response.status, 200);
  const kinds: string[] = [];
  for await (const frame of clientMessages(response, "baseline-race")) {
    kinds.push(frame.kind);
    if (frame.kind === "event") assert.equal(frame.value.type, "snapshot");
    else { assert.equal(frame.kind, "end"); assert.ok(frame.kind === "end"); assert.equal(frame.reason, "stopped"); }
  }
  assert.equal(triggered, true); assert.deepEqual(kinds, ["event", "end"]); assert.ok(closing);
  await bounded(closing); await assert.rejects(fetch(ingress.endpoint)); assert.equal(faux.state.callCount, 0);
  const result = { proof: "client-http-baseline-start-close", root, realServerResponseWriteSeam: true, actualWatchStoppedBeforeStart: true, snapshotThenTypedStoppedEnd: true, noInference: true, productionModelAcceptance: false };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600, flag: "wx", flush: true }); process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  if (descriptor === undefined) Reflect.deleteProperty(ServerResponse.prototype, "write"); else Object.defineProperty(ServerResponse.prototype, "write", descriptor);
  await closing; await host.close();
}
