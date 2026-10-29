import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { HostIdentity } from "#host-protocol";
import { isIdentityName, parseWorkspaceId, type WorkspaceId } from "./workspace-identity.js";

export type ClientPermission = "read" | "submit" | "abort" | "command.cancel";
export type ClientWorkspace = { readonly workspaceId: WorkspaceId; readonly cwd: string };
export type ClientScope = { readonly workspaceId: WorkspaceId; readonly permissions: readonly ClientPermission[] };
export type ClientConfig = {
  readonly version: 1;
  readonly listen: { readonly host: "127.0.0.1"; readonly port: number };
  readonly workspaces: readonly ClientWorkspace[];
  readonly grants: readonly {
    readonly principalId: string;
    readonly tokenFile: string;
    readonly workspaces: readonly ClientScope[];
  }[];
};
export type ClientCredential = {
  readonly version: 1;
  readonly identity: HostIdentity;
  readonly principalId: string;
  readonly secret: string;
};
export type ClientErrorCode = "invalid_request" | "invalid_config" | "invalid_credential" | "unauthenticated" | "scope_denied";

export class ClientError extends Error {
  constructor(readonly code: ClientErrorCode, message: string) { super(message); }
}

function invalid(): never { throw new ClientError("invalid_request", "Invalid client input"); }

export function clientObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = Object.fromEntries(Object.entries(value));
  if (Object.keys(result).some(key => !fields.includes(key))) return invalid();
  return result;
}

export function clientText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0") || value.length === 0 || Buffer.byteLength(value) > maxBytes) return invalid();
  return value;
}

export function clientIdentifier(value: unknown, maxBytes = 200): string {
  const result = clientText(value, maxBytes);
  if (!isIdentityName(result)) return invalid();
  return result;
}

export function clientWorkspaceId(value: unknown): WorkspaceId {
  const result = parseWorkspaceId(clientIdentifier(value));
  if (result === undefined) return invalid();
  return result;
}

function absolute(value: unknown): string {
  const result = clientText(value, 4095);
  if (!isAbsolute(result)) return invalid();
  return result;
}

function list(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return invalid();
  return value;
}

function permission(value: unknown): ClientPermission {
  switch (value) {
    case "read": case "submit": case "abort": case "command.cancel": return value;
    default: return invalid();
  }
}

export function parseClientConfig(value: unknown): ClientConfig {
  try {
    const config = clientObject(value, ["version", "listen", "workspaces", "grants"]);
    if (config.version !== 1) return invalid();
    const listen = clientObject(config.listen, ["host", "port"]);
    if (listen.host !== "127.0.0.1" || typeof listen.port !== "number" || !Number.isSafeInteger(listen.port) || listen.port < 0 || listen.port > 65535) return invalid();
    const workspaceIds = new Set<WorkspaceId>();
    const workspaces = list(config.workspaces, 16).map(value => {
      const workspace = clientObject(value, ["workspaceId", "cwd"]);
      const workspaceId = clientWorkspaceId(workspace.workspaceId);
      if (workspaceIds.has(workspaceId)) return invalid();
      workspaceIds.add(workspaceId);
      return Object.freeze({ workspaceId, cwd: absolute(workspace.cwd) });
    });
    const principalIds = new Set<string>();
    const tokenFiles = new Set<string>();
    const grants = list(config.grants, 16).map(value => {
      const grant = clientObject(value, ["principalId", "tokenFile", "workspaces"]);
      const principalId = clientIdentifier(grant.principalId, 128);
      const tokenFile = absolute(grant.tokenFile);
      if (principalIds.has(principalId) || tokenFiles.has(tokenFile)) return invalid();
      principalIds.add(principalId);
      tokenFiles.add(tokenFile);
      const granted = new Set<WorkspaceId>();
      const scopes = list(grant.workspaces, 16).map(value => {
        const scope = clientObject(value, ["workspaceId", "permissions"]);
        const workspaceId = clientWorkspaceId(scope.workspaceId);
        if (!workspaceIds.has(workspaceId) || granted.has(workspaceId)) return invalid();
        granted.add(workspaceId);
        const permissions = list(scope.permissions, 4).map(permission);
        if (new Set(permissions).size !== permissions.length) return invalid();
        return Object.freeze({ workspaceId, permissions: Object.freeze(permissions) });
      });
      return Object.freeze({ principalId, tokenFile, workspaces: Object.freeze(scopes) });
    });
    return Object.freeze({ version: 1, listen: Object.freeze({ host: "127.0.0.1", port: listen.port }), workspaces: Object.freeze(workspaces), grants: Object.freeze(grants) });
  } catch {
    throw new ClientError("invalid_config", "Invalid client configuration");
  }
}

function identity(value: unknown): HostIdentity {
  const parsed = clientObject(value, ["deploymentId", "domain", "nodeId"]);
  if (parsed.domain !== "personal" && parsed.domain !== "work") return invalid();
  return Object.freeze({ deploymentId: clientIdentifier(parsed.deploymentId), domain: parsed.domain, nodeId: clientIdentifier(parsed.nodeId) });
}

function identityBytes(value: HostIdentity): string {
  return JSON.stringify([value.deploymentId, value.domain, value.nodeId]);
}

export function parseClientCredential(value: unknown): ClientCredential {
  try {
    const credential = clientObject(value, ["version", "identity", "principalId", "secret"]);
    if (credential.version !== 1) return invalid();
    const secret = clientText(credential.secret, 43);
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return invalid();
    const bytes = Buffer.from(secret, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== secret) return invalid();
    return Object.freeze({ version: 1, identity: identity(credential.identity), principalId: clientIdentifier(credential.principalId, 128), secret });
  } catch {
    throw new ClientError("invalid_credential", "Invalid client credential");
  }
}

export function newClientCredential(options: { readonly identity: HostIdentity; readonly principalId: string }): ClientCredential {
  return parseClientCredential({ version: 1, identity: options.identity, principalId: options.principalId, secret: randomBytes(32).toString("base64url") });
}

export function clientToken(credential: ClientCredential): string {
  return `hpc1.${createHash("sha256").update(identityBytes(credential.identity)).digest("hex")}.${credential.secret}`;
}

export async function loadClientCredential(path: string): Promise<ClientCredential> {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new ClientError("invalid_credential", "Client credentials require a nonroot local user");
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      const mode = stat.mode & 0o7777;
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (mode !== 0o400 && mode !== 0o600)) throw new ClientError("invalid_credential", "Unsafe client credential file");
      const bytes = Buffer.alloc(4097);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size === bytes.length) throw new ClientError("invalid_credential", "Client credential exceeds byte limit");
      return parseClientCredential(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
    } finally { await file.close(); }
  } catch {
    throw new ClientError("invalid_credential", "Client credential reference is unavailable or invalid");
  }
}

export type ClientRequestKey =
  | { readonly kind: "open"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "submit"; readonly workspaceId: WorkspaceId; readonly requestId: string };

export type ClientAccess = {
  readonly principalId: string;
  discover(): readonly ClientScope[];
  require(options: { readonly workspaceId: WorkspaceId; readonly permission: ClientPermission }): ClientWorkspace;
  requestId(options: ClientRequestKey): string;
};

type VerifiedGrant = {
  readonly principalId: string;
  readonly verifier: Buffer;
  readonly scopes: readonly ClientScope[];
  readonly permissions: ReadonlyMap<WorkspaceId, ReadonlySet<ClientPermission>>;
};

export class ClientAuthority {
  private constructor(
    private readonly hostIdentity: HostIdentity,
    private readonly workspaces: ReadonlyMap<WorkspaceId, ClientWorkspace>,
    private readonly grants: readonly VerifiedGrant[],
  ) {}

  static async open(options: { readonly identity: HostIdentity; readonly config: ClientConfig }): Promise<ClientAuthority> {
    const grants: VerifiedGrant[] = [];
    const verifiers = new Set<string>();
    for (const grant of options.config.grants) {
      const credential = await loadClientCredential(grant.tokenFile);
      if (credential.principalId !== grant.principalId || identityBytes(credential.identity) !== identityBytes(options.identity))
        throw new ClientError("invalid_credential", "Client credential identity differs from its configured grant");
      const verifier = createHash("sha256").update(clientToken(credential)).digest();
      const key = verifier.toString("hex");
      if (verifiers.has(key)) throw new ClientError("invalid_credential", "Client credentials must identify distinct grants");
      verifiers.add(key);
      grants.push({ principalId: grant.principalId, verifier, scopes: grant.workspaces, permissions: new Map(grant.workspaces.map(scope => [scope.workspaceId, new Set(scope.permissions)])) });
    }
    return new ClientAuthority(Object.freeze({ ...options.identity }), new Map(options.config.workspaces.map(workspace => [workspace.workspaceId, workspace])), grants);
  }

  authenticate(token: string | undefined): ClientAccess {
    if (token === undefined || !/^hpc1\.[0-9a-f]{64}\.[A-Za-z0-9_-]{43}$/.test(token)) throw new ClientError("unauthenticated", "Client authentication failed");
    const verifier = createHash("sha256").update(token).digest();
    let matched: VerifiedGrant | undefined;
    for (const grant of this.grants) if (timingSafeEqual(grant.verifier, verifier)) matched = grant;
    if (matched === undefined) throw new ClientError("unauthenticated", "Client authentication failed");
    const grant = matched;
    const workspace = (workspaceId: WorkspaceId) => {
      const allowed = grant.permissions.get(workspaceId);
      const configured = this.workspaces.get(workspaceId);
      if (allowed === undefined || configured === undefined) throw new ClientError("scope_denied", "Client scope does not permit this operation");
      return { allowed, configured };
    };
    return Object.freeze({
      principalId: grant.principalId,
      discover: () => grant.scopes,
      require: (options: { readonly workspaceId: WorkspaceId; readonly permission: ClientPermission }) => {
        const selected = workspace(options.workspaceId);
        if (!selected.allowed.has(options.permission)) throw new ClientError("scope_denied", "Client scope does not permit this operation");
        return selected.configured;
      },
      requestId: (options: ClientRequestKey) => {
        workspace(options.workspaceId);
        return `client.v1.${createHash("sha256").update(JSON.stringify(["clients.v1", identityBytes(this.hostIdentity), grant.principalId, options.workspaceId, options.kind, options.kind === "open" ? null : options.requestId])).digest("hex")}`;
      },
    });
  }
}
