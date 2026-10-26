import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { newClientCredential } from "#client-authority";
import { ClientServer } from "#client-http";
import { DurableHost } from "#durable-host";
import { parseHostConfig } from "#host-protocol";

const root = await mkdtemp(join(tmpdir(), "client-bind-")), cwd = join(root, "workspace");
process.stderr.write(`${JSON.stringify({ fixture: "client-bind", root })}\n`);
await mkdir(cwd, { mode: 0o700 });
const identity = { deploymentId: "client-bind", domain: "personal", nodeId: "fixture" } satisfies Parameters<typeof newClientCredential>[0]["identity"];
const credential = newClientCredential({ identity, principalId: "reader" }), tokenFile = join(root, "reader.key");
await writeFile(tokenFile, JSON.stringify(credential), { flag: "wx", mode: 0o600, flush: true });
const holder = createServer();
await new Promise<void>((resolve, reject) => { holder.once("error", reject); holder.listen({ host: "127.0.0.1", port: 0 }, resolve); });
const address = holder.address(); assert.ok(address !== null && typeof address !== "string");
const config = parseHostConfig({ identity, stateRoot: join(root, "state"), model: { provider: "client-bind", modelId: "text" }, thinkingLevel: "off", authPath: join(root, "unused-auth"), modelsPath: join(root, "unused-models"), execution: { mode: "durable", maxRecords: 256, clients: { version: 1, listen: { host: "127.0.0.1", port: address.port }, workspaces: [{ workspaceId: "coding", cwd }], grants: [{ principalId: "reader", tokenFile, workspaces: [{ workspaceId: "coding", permissions: ["read"] }] }] } } });
const faux = fauxProvider({ api: "client-bind", provider: "client-bind", models: [{ id: "text", input: ["text"] }] });
const models = createModels(); models.setProvider(faux.provider);
let host: DurableHost | undefined;
try {
  host = await DurableHost.open(config, models);
  let failure: unknown;
  try { await ClientServer.open(host); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error);
  const code = "code" in failure ? failure.code : undefined;
  await writeFile(join(root, "observed-error.json"), JSON.stringify({ name: failure.name, message: failure.message, code: code ?? null }, null, 2), { flag: "wx", mode: 0o600, flush: true });
  assert.equal(code, "EADDRINUSE", "Startup must preserve the actual bind error, not mislabel it cleanup failure");
  await host.close(); host = undefined; assert.equal(faux.state.callCount, 0);
  const result = { proof: "client-http-bind-failure", root, code, originalErrorPreserved: true, ownerCleanlyClosed: true, productionModelAcceptance: false };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600, flush: true }); process.stdout.write(`${JSON.stringify(result)}\n`);
} finally { await host?.close().catch(() => undefined); await new Promise<void>(resolve => holder.close(() => resolve())); }
