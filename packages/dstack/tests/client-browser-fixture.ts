import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { newClientCredential } from "#client-authority";
import { ClientServer } from "#client-http";
import { DurableHost } from "#durable-host";
import { parseHostConfig } from "#host-protocol";

process.umask(0o077);
const root = await mkdtemp(join(tmpdir(), "client-browser-")), cwd = join(root, "workspace"); await mkdir(cwd, { mode: 0o700 });
const identity = { deploymentId: "browser-fixture", domain: "personal", nodeId: "fixture" } satisfies Parameters<typeof newClientCredential>[0]["identity"];
for (const principalId of ["writer", "reader", "foreign"]) {
  const audience: Parameters<typeof newClientCredential>[0]["identity"] = principalId === "foreign" ? { ...identity, domain: "work" } : identity;
  const credential = newClientCredential({ identity: audience, principalId });
  await writeFile(join(root, `${principalId}.key`), JSON.stringify(credential), { flag: "wx", mode: 0o600, flush: true });
}
const config = parseHostConfig({ identity, stateRoot: join(root, "state"), model: { provider: "browser-fixture", modelId: "text" }, thinkingLevel: "off", authPath: join(root, "unused-auth"), modelsPath: join(root, "unused-models"), execution: { mode: "durable", maxRecords: 256, clients: { version: 1, listen: { host: "127.0.0.1", port: 0 }, workspaces: [{ workspaceId: "coding", cwd }], grants: ["writer", "reader"].map(principalId => ({ principalId, tokenFile: join(root, `${principalId}.key`), workspaces: [{ workspaceId: "coding", permissions: principalId === "writer" ? ["read", "submit", "abort", "command.cancel"] : ["read"] }] })) } } });
const faux = fauxProvider({ api: "browser-fixture", provider: "browser-fixture", models: [{ id: "text", input: ["text"] }], tokensPerSecond: 20, tokenSize: { min: 4, max: 4 } });
faux.setResponses([
  fauxAssistantMessage("Browser fixture: <img src=x onerror=alert(1)> stays literal text. Committed progress belongs to the actual Durable owner, and detaching a viewer does not cancel this generation. A fresh snapshot observes the same work without submitting it again. ".repeat(3)),
  fauxAssistantMessage("This second response is deliberately long enough to exercise an explicit SDK abort while the actual generation is active. Ordinary SDK abort does not fabricate an independent business receipt. ".repeat(5)),
]);
const models = createModels(); models.setProvider(faux.provider);
const host = await DurableHost.open(config, models);
try {
  const ingress = await ClientServer.open(host);
  const ready = { fixture: "client-browser-ready", root, endpoint: ingress.endpoint, writerFile: join(root, "writer.key"), readerFile: join(root, "reader.key"), foreignFile: join(root, "foreign.key"), productionModel: false };
  await writeFile(join(root, "ready.json"), JSON.stringify(ready, null, 2), { flag: "wx", mode: 0o600, flush: true });
  process.stdout.write(`${JSON.stringify(ready)}\n`);
  let finish: (() => void) | undefined;
  const done = new Promise<void>(resolve => { finish = resolve; });
  process.stdin.once("end", () => finish?.()); process.stdin.once("close", () => finish?.()); process.stdin.resume();
  const timer = setTimeout(() => finish?.(), 15 * 60 * 1000);
  try { await done; } finally { clearTimeout(timer); process.stdin.pause(); }
} finally {
  await host.close();
  const result = { fixture: "client-browser-closed", root, providerCalls: faux.state.callCount, productionModel: false };
  await writeFile(join(root, "closed.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600, flush: true }); process.stdout.write(`${JSON.stringify(result)}\n`);
}
