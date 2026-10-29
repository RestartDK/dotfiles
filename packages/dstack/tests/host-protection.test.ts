import { expect, test } from "bun:test";
import { chmod, link, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionControlPaths, parseControlPaths, requireDeploymentProtection } from "../src/host-protection.js";
import { loadHostConfig, parseHostConfig } from "#host-protocol";

const home = "/home/protection-test";
const config = () => parseHostConfig({
  identity: { deploymentId: "protection", domain: "personal", nodeId: "node" },
  stateRoot: `${home}/.local/state/herdr-durable/personal/owner`,
  model: { provider: "fixture", modelId: "text" }, thinkingLevel: "off",
  authPath: `${home}/.pi/agent/auth.json`, modelsPath: `${home}/.config/dstack/models.json`,
  execution: { mode: "durable", maxRecords: 256, clients: {
    version: 1, listen: { host: "127.0.0.1", port: 23456 },
    workspaces: [{ workspaceId: "coding", cwd: home }],
    grants: [{ principalId: "operator", tokenFile: `${home}/.config/herdr-durable/personal/token.json`, workspaces: [{ workspaceId: "coding", permissions: ["read"] }] }],
  } },
});

test("production control policy covers PR, wake, model policy, agent and all deployment roots independently of isolated XDG state", () => {
  const paths = productionControlPaths({ XDG_STATE_HOME: `${home}/isolated-state`, XDG_CONFIG_HOME: `${home}/isolated-config`, DSTACK_STATE_DIR: `${home}/actual-jobs`, DSTACK_SOCKET: `${home}/custom.sock`, DSTACK_PROTECTED_PATHS: JSON.stringify([`${home}/retained-old-keys`, `${home}/retained-old-keys`]) }, home);
  for (const path of ["actual-jobs", "custom.sock", "isolated-config/dstack", ".config/dstack", ".config/gh", ".ssh", ".git-credentials", ".pi/agent", ".config/herdr-durable", ".local/state/herdr-durable", "retained-old-keys"]) expect(paths).toContain(`${home}/${path}`);
  expect(paths.filter(path => path.endsWith("retained-old-keys"))).toHaveLength(1);
  expect(Object.isFrozen(paths)).toBe(true);
});

test("control policy parsing is bounded, closed to nonpaths and canonical in ordering without changing path bytes", () => {
  expect(parseControlPaths(["/z/\u0085", "/a", "/a"])).toEqual(["/a", "/z/\u0085"]);
  for (const input of [[], ["relative"], ["/nul\0"], ["/\ud800"], ["/" + "a".repeat(4095)], Array(65).fill("/a"), [1]]) expect(() => parseControlPaths(input)).toThrow();
  expect(() => productionControlPaths({ DSTACK_PROTECTED_PATHS: "{}" }, home)).toThrow();
  expect(() => productionControlPaths({ DSTACK_PROTECTED_PATHS: " ".repeat(16385) }, home)).toThrow();
});

test("deployment mode requires authenticated fixed-port ownership and protected references, not caller domain or path prefixes", () => {
  const current = config(), controlPaths = productionControlPaths({}, home), configPath = `${home}/.config/herdr-durable/personal/host.json`;
  expect(() => requireDeploymentProtection({ config: current, controlPaths, configPath })).not.toThrow();
  expect(() => requireDeploymentProtection({ config: { ...current, stateRoot: `${home}/.local/state/herdr-durable-other/owner` }, controlPaths, configPath })).toThrow(/protected control roots/);
  expect(() => requireDeploymentProtection({ config: { ...current, authPath: `${home}/.pi/agent/../../unprotected/auth.json` }, controlPaths, configPath })).toThrow(/protected control roots/);
  expect(() => requireDeploymentProtection({ config: { ...current, execution: undefined }, controlPaths, configPath })).toThrow(/authenticated clients/);
  const clients = current.execution?.clients; expect(clients).toBeDefined();
  if (clients === undefined) throw new Error("Fixture requires clients");
  expect(() => requireDeploymentProtection({ config: { ...current, execution: { mode: "durable", maxRecords: 256, clients: { ...clients, listen: { host: "127.0.0.1", port: 0 } } } }, controlPaths, configPath })).toThrow(/fixed loopback port/);
});

test("private runtime Host config is nonroot-owned single-link regular and exactly 0400 or 0600", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-private-config-")), path = join(root, "host.json");
  await writeFile(path, JSON.stringify(config()), { flag: "wx", mode: 0o600 });
  const load = (file = path) => loadHostConfig({ path: file, expectedSha256: undefined, access: "private-runtime" });
  expect(await load()).toEqual(config());
  for (const mode of [0o400, 0o600]) { await chmod(path, mode); expect(await load()).toEqual(config()); }
  for (const mode of [0o440, 0o644]) { await chmod(path, mode); await expect(load()).rejects.toThrow(/private owned regular file/); }
  await chmod(path, 0o600);
  const alias = join(root, "alias"), hard = join(root, "hard"); await symlink(path, alias);
  await expect(load(alias)).rejects.toThrow();
  await link(path, hard); await expect(load()).rejects.toThrow(/private owned regular file/);
  await expect(load(root)).rejects.toThrow(/private owned regular file/);
});
