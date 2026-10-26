import { expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClientAuthority, ClientError, clientToken, clientWorkspaceId, loadClientCredential, newClientCredential, parseClientConfig, parseClientCredential, type ClientCredential } from "#client-authority";
import { clientPermission, parseClientEnvelope, parseClientOperation, type ClientOperation } from "#client-protocol";
import type { HostIdentity } from "#host-protocol";

const identity: HostIdentity = { deploymentId: "client-proof", domain: "personal", nodeId: "node-a" };
const repository = clientWorkspaceId("repository");
const other = clientWorkspaceId("other");

function policy(root: string) {
  return {
    version: 1,
    listen: { host: "127.0.0.1", port: 0 },
    workspaces: [{ workspaceId: repository, cwd: join(root, "repository") }, { workspaceId: other, cwd: join(root, "other") }],
    grants: [
      { principalId: "reader", tokenFile: join(root, "reader.key"), workspaces: [{ workspaceId: repository, permissions: ["read"] }] },
      { principalId: "operator", tokenFile: join(root, "operator.key"), workspaces: [{ workspaceId: repository, permissions: ["read", "submit", "abort", "command.cancel"] }, { workspaceId: other, permissions: ["submit"] }] },
    ],
  };
}

async function save(path: string, credential: ClientCredential): Promise<void> {
  await writeFile(path, JSON.stringify(credential), { mode: 0o600 });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "client-authority-"));
  await chmod(root, 0o700);
  await mkdir(join(root, "repository"), { mode: 0o700 });
  await mkdir(join(root, "other"), { mode: 0o700 });
  const reader = newClientCredential({ identity, principalId: "reader" });
  const operator = newClientCredential({ identity, principalId: "operator" });
  await save(join(root, "reader.key"), reader);
  await save(join(root, "operator.key"), operator);
  const raw = policy(root);
  const config = parseClientConfig(raw);
  return { root, reader, operator, raw, config };
}

test("client policy is closed, loopback-only and grants only configured workspaces", () => {
  const raw = policy("/private");
  expect(parseClientConfig(raw).listen.host).toBe("127.0.0.1");
  for (const value of [
    { ...raw, profile: "work" }, { ...raw, actor: "admin" }, { ...raw, version: 2 },
    { ...raw, listen: { host: "0.0.0.0", port: 7719 } },
    { ...raw, listen: { host: "127.0.0.1", port: 65536 } },
    { ...raw, listen: { host: "127.0.0.1", port: 1.5 } },
    { ...raw, workspaces: [...raw.workspaces, ...raw.workspaces] },
    { ...raw, workspaces: [{ workspaceId: "relative", cwd: "relative" }] },
    { ...raw, grants: [...raw.grants, ...raw.grants] },
    { ...raw, grants: [{ principalId: "reader", tokenFile: "/key", workspaces: [{ workspaceId: "not-configured", permissions: ["read"] }] }] },
    { ...raw, grants: [{ principalId: "reader", tokenFile: "/key", workspaces: [{ workspaceId: repository, permissions: ["read", "read"] }] }] },
    { ...raw, grants: [{ principalId: "reader", tokenFile: "/key", workspaces: [{ workspaceId: repository, permissions: ["authorize"] }] }] },
    { ...raw, grants: [{ principalId: "reader", tokenFile: "/key", workspaces: [{ workspaceId: repository, permissions: ["read"], actor: "admin" }] }] },
  ]) expect(() => parseClientConfig(value)).toThrow(ClientError);
  expect(Object.isFrozen(parseClientConfig(raw).grants)).toBe(true);
});

test("actual configured credential bytes mint only their exact principal, workspace and operation grants", async () => {
  const f = await fixture();
  const authority = await ClientAuthority.open({ identity, config: f.config });
  const reader = authority.authenticate(clientToken(f.reader));
  expect(reader.principalId).toBe("reader");
  expect(reader.discover()).toEqual([{ workspaceId: repository, permissions: ["read"] }]);
  expect(reader.require({ workspaceId: repository, permission: "read" }).cwd).toBe(join(f.root, "repository"));
  for (const permission of ["submit", "abort", "command.cancel"] satisfies ("submit" | "abort" | "command.cancel")[])
    expect(() => reader.require({ workspaceId: repository, permission })).toThrow(/scope/);
  expect(() => reader.require({ workspaceId: other, permission: "read" })).toThrow(/scope/);
  const operator = authority.authenticate(clientToken(f.operator));
  expect(operator.require({ workspaceId: repository, permission: "command.cancel" }).workspaceId).toBe(repository);
  expect(operator.require({ workspaceId: other, permission: "submit" }).workspaceId).toBe(other);
  expect(() => operator.require({ workspaceId: other, permission: "read" })).toThrow(/scope/);
  for (const token of [undefined, "", "admin", "Bearer admin", clientToken(newClientCredential({ identity, principalId: "reader" }))])
    expect(() => authority.authenticate(token)).toThrow(/authentication failed/);
});

test("credential audience and principal bind exact bytes independently of billing or caller claims", async () => {
  const f = await fixture();
  for (const changedIdentity of [
    { ...identity, domain: "work" } satisfies HostIdentity,
    { ...identity, deploymentId: "other" },
    { ...identity, nodeId: "other" },
  ]) {
    await expect(ClientAuthority.open({ identity: changedIdentity, config: f.config })).rejects.toThrow(/identity differs/);
    const authority = await ClientAuthority.open({ identity, config: f.config });
    expect(() => authority.authenticate(clientToken(parseClientCredential({ ...f.reader, identity: changedIdentity })))).toThrow(/authentication failed/);
  }
  await save(join(f.root, "reader.key"), parseClientCredential({ ...f.reader, principalId: "operator" }));
  await expect(ClientAuthority.open({ identity, config: f.config })).rejects.toThrow(/identity differs/);
  const padded = { deploymentId: " deployment ", domain: "personal", nodeId: "\u0085" } satisfies HostIdentity;
  expect(newClientCredential({ identity: padded, principalId: " reader " }).identity).toEqual(padded);
  expect(() => newClientCredential({ identity: { ...padded, nodeId: "\ufeff" }, principalId: "reader" })).toThrow(ClientError);
});

test("separate credential files cannot assign the same effective token to two principals", async () => {
  const f = await fixture();
  await save(join(f.root, "operator.key"), parseClientCredential({ ...f.operator, secret: f.reader.secret }));
  await expect(ClientAuthority.open({ identity, config: f.config })).rejects.toThrow(/distinct grants/);
});

test("principal-scoped request keys survive owner and key epochs without cross-scope collisions", async () => {
  const f = await fixture();
  const first = await ClientAuthority.open({ identity, config: f.config });
  const reader = first.authenticate(clientToken(f.reader));
  const key = reader.requestId({ kind: "submit", workspaceId: repository, requestId: "request-1" });
  expect(key).toMatch(/^client\.v1\.[0-9a-f]{64}$/);
  const openKey = reader.requestId({ kind: "open", workspaceId: repository });
  expect(openKey).not.toBe(key);
  expect(openKey).not.toBe(reader.requestId({ kind: "submit", workspaceId: repository, requestId: "open" }));
  const reopened = await ClientAuthority.open({ identity, config: f.config });
  expect(reopened.authenticate(clientToken(f.reader)).requestId({ kind: "submit", workspaceId: repository, requestId: "request-1" })).toBe(key);
  const operator = first.authenticate(clientToken(f.operator));
  expect(operator.requestId({ kind: "submit", workspaceId: repository, requestId: "request-1" })).not.toBe(key);
  expect(operator.requestId({ kind: "submit", workspaceId: repository, requestId: "request-1" })).not.toBe(operator.requestId({ kind: "submit", workspaceId: other, requestId: "request-1" }));
  expect(reader.requestId({ kind: "submit", workspaceId: repository, requestId: "request-2" })).not.toBe(key);
  expect(() => reader.requestId({ kind: "submit", workspaceId: other, requestId: "request-1" })).toThrow(/scope/);
  const rotated = newClientCredential({ identity, principalId: "reader" });
  await save(join(f.root, "reader.key"), rotated);
  expect(first.authenticate(clientToken(f.reader)).principalId).toBe("reader");
  expect(() => first.authenticate(clientToken(rotated))).toThrow(/authentication failed/);
  const next = await ClientAuthority.open({ identity, config: f.config });
  expect(() => next.authenticate(clientToken(f.reader))).toThrow(/authentication failed/);
  expect(next.authenticate(clientToken(rotated)).requestId({ kind: "submit", workspaceId: repository, requestId: "request-1" })).toBe(key);
});

test("credential loading refuses real aliases, public permissions, invalid bytes and oversized input without echoing secrets", async () => {
  const f = await fixture();
  const path = join(f.root, "reader.key");
  expect(await loadClientCredential(path)).toEqual(f.reader);
  await chmod(path, 0o400);
  expect(await loadClientCredential(path)).toEqual(f.reader);
  await chmod(path, 0o644);
  await expect(loadClientCredential(path)).rejects.toThrow(/unavailable or invalid/);
  await chmod(path, 0o600);
  const alias = join(f.root, "alias.key");
  await symlink(path, alias);
  await expect(loadClientCredential(alias)).rejects.toThrow(/unavailable or invalid/);
  const hardAlias = join(f.root, "hard-alias.key");
  await link(path, hardAlias);
  await expect(loadClientCredential(path)).rejects.toThrow(/unavailable or invalid/);
  await expect(loadClientCredential(hardAlias)).rejects.toThrow(/unavailable or invalid/);
  const invalid = join(f.root, "invalid.key");
  for (const bytes of [Buffer.from('{"secret":"SENSITIVE-MUST-NOT-APPEAR",'), Buffer.from([0xff]), Buffer.alloc(4097, 65)]) {
    await writeFile(invalid, bytes, { mode: 0o600 });
    try { await loadClientCredential(invalid); throw new Error("Invalid credential was accepted"); }
    catch (error) {
      expect(error).toBeInstanceOf(ClientError);
      expect(error instanceof Error && error.message.includes("SENSITIVE-MUST-NOT-APPEAR")).toBe(false);
    }
  }
});

test("client operation parser excludes caller authority and keeps SDK abort separate from business cancel", () => {
  const valid = [
    { op: "discover" }, { op: "open", workspaceId: repository },
    { op: "submit", workspaceId: repository, requestId: " req ", content: "hello" },
    { op: "status", workspaceId: repository, requestId: " req " },
    { op: "snapshot", workspaceId: repository, cursor: "opaque-owner-token" },
    { op: "watch", workspaceId: repository }, { op: "abort", workspaceId: repository },
    { op: "execution.status", workspaceId: repository },
    { op: "command.cancel", workspaceId: repository, intentId: "already-authorized" },
  ] satisfies ClientOperation[];
  expect(valid.map(value => clientPermission(parseClientOperation(value)))).toEqual([undefined, "submit", "submit", "read", "read", "read", "abort", "read", "command.cancel"]);
  for (const operation of valid) expect(parseClientEnvelope({ v: 1, id: "correlation", operation }).operation.op).toBe(operation.op);
  for (const field of ["actor", "principalId", "profile", "cwd", "root", "environment", "captureEpoch", "sourceBootId", "approval", "keepCaps", "background"])
    expect(() => parseClientOperation({ op: "watch", workspaceId: repository, [field]: "forged" })).toThrow(ClientError);
  for (const op of ["command.authorize", "command.start", "command.reconcile", "file.reconcile", "shell", "resume"])
    expect(() => parseClientOperation({ op, workspaceId: repository })).toThrow(ClientError);
  expect(() => parseClientOperation({ op: "abort", workspaceId: repository, intentId: "forged" })).toThrow(ClientError);
  expect(() => parseClientEnvelope({ v: 2, id: "correlation", operation: { op: "discover" } })).toThrow(ClientError);
  expect(() => parseClientEnvelope({ v: 1, id: "correlation", operation: { op: "discover" }, actor: "admin" })).toThrow(ClientError);
  expect(() => parseClientOperation({ op: "submit", workspaceId: repository, requestId: "request", content: "a".repeat(65537) })).toThrow(ClientError);
  expect(() => parseClientOperation({ op: "submit", workspaceId: repository, requestId: "request", content: "\ud800" })).toThrow(ClientError);
});
