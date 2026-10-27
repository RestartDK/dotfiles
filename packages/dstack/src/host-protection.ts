import { isAbsolute, join, relative, sep } from "node:path";
import type { HostConfig } from "#host-protocol";

export function parseControlPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64)
    throw new Error("Host control protection requires 1 to 64 absolute paths");
  const paths: string[] = [];
  for (const path of value) {
    if (typeof path !== "string" || !isAbsolute(path) || !path.isWellFormed() || path.includes("\0") || Buffer.byteLength(path) > 4095)
      throw new Error("Invalid host control protection path");
    paths.push(path);
  }
  return Object.freeze([...new Set(paths)].sort());
}

export function requireDeploymentProtection(options: { readonly config: HostConfig; readonly configPath: string; readonly controlPaths: readonly string[] }): void {
  const { config, configPath, controlPaths } = options;
  if (config.execution?.clients === undefined || config.execution.clients.listen.port === 0)
    throw new Error("A deployed Host requires durable execution, authenticated clients, and a fixed loopback port");
  const references = [configPath, config.stateRoot, config.authPath, config.modelsPath, ...config.execution.clients.grants.map(grant => grant.tokenFile)];
  if (references.some(reference => !controlPaths.some(root => {
    const path = relative(root, reference); return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  }))) throw new Error("Deployed Host control references must stay inside protected control roots");
}

export function productionControlPaths(env: Readonly<NodeJS.ProcessEnv>, home: string): readonly string[] {
  const configHome = env.XDG_CONFIG_HOME ?? join(home, ".config");
  const stateHome = env.XDG_STATE_HOME ?? join(home, ".local/state");
  const jobs = env.DSTACK_STATE_DIR ?? join(stateHome, "dstack");
  const encoded = env.DSTACK_PROTECTED_PATHS;
  if (encoded !== undefined && Buffer.byteLength(encoded) > 16384) throw new Error("Additional host control protection exceeds byte limit");
  const extra: unknown = encoded === undefined ? [] : JSON.parse(encoded);
  if (!Array.isArray(extra)) throw new Error("Invalid additional host control protection");
  return parseControlPaths([
    jobs, env.DSTACK_SOCKET ?? join(jobs, "jobs.sock"),
    join(configHome, "dstack"), join(home, ".config/dstack"),
    env.GH_CONFIG_DIR ?? join(configHome, "gh"), join(home, ".config/gh"),
    join(home, ".ssh"), join(home, ".git-credentials"), join(home, ".gitconfig"), join(home, ".config/git"),
    env.PI_CODING_AGENT_DIR ?? join(home, ".pi/agent"), join(home, ".pi/agent"),
    join(home, ".config/herdr-durable"), join(home, ".local/state/herdr-durable"),
    ...extra,
  ]);
}
