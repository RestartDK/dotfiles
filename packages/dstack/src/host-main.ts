import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DurableHost } from "#durable-host";
import { hostCommandRuntime } from "./host-runtime.js";
import { loadHostConfig } from "#host-protocol";
import { serveHost } from "#host-stdio";
import { ClientServer } from "#client-http";

process.umask(0o077);
try {
  const configPath = process.argv[2];
  if (process.argv.length !== 3 || configPath === undefined)
    throw new Error("Usage: dstack-host <config.json>");
  const config = await loadHostConfig({
    path: configPath,
    expectedSha256: process.env.HERDR_DURABLE_HOST_CONFIG_SHA256,
  });
  const models = await ModelRuntime.create({
    authPath: config.authPath,
    modelsPath: config.modelsPath,
    modelsStorePath: join(config.stateRoot, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const host = await DurableHost.open(config, models, { protectedPaths: [configPath], commands: config.execution === undefined ? undefined : await hostCommandRuntime() });
  const stop = () => process.stdin.destroy();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    if (config.execution?.clients !== undefined) await ClientServer.open(host);
    await serveHost(host, process.stdin, process.stdout);
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await host.close();
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
