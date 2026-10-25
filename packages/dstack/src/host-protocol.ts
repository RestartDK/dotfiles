import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { isAbsolute } from "node:path";
import { isIdentityName, parseWorkspaceId, type WorkspaceId } from "./workspace-identity.js";
import { parseCommandParameters, type CommandParameters } from "./command-wire.js";
import type { TrustedReconciliation } from "./execution-commands.js";

export const HOST_VERSION = 1;
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_WORKSPACES = 16;
export const MAX_PENDING_INPUTS = 32;

export type HostIdentity = {
  readonly deploymentId: string;
  readonly domain: "work" | "personal";
  readonly nodeId: string;
};

export type HostConfig = {
  readonly identity: HostIdentity;
  readonly stateRoot: string;
  readonly model: ModelRef;
  readonly thinkingLevel: ModelThinkingLevel;
  readonly authPath: string;
  readonly modelsPath: string;
  readonly execution?: { readonly mode: "durable"; readonly maxRecords: number };
};

export type HostMutation =
  | { op: "create"; requestId: string; workspaceId: WorkspaceId; cwd: string }
  | { op: "submit"; requestId: string; workspaceId: WorkspaceId; content: string };

export type HostCommandOperation =
  | { op: "execution.status"; workspaceId: WorkspaceId }
  | { op: "command.authorize"; workspaceId: WorkspaceId; intentId: string; spec: CommandParameters }
  | { op: "command.start" | "command.status" | "command.inspect" | "command.adopt" | "command.cancel" | "command.release"; workspaceId: WorkspaceId; intentId: string }
  | ({ op: "command.reconcile"; workspaceId: WorkspaceId } & Omit<TrustedReconciliation, "actor">)
  | { op: "file.reconcile"; workspaceId: WorkspaceId; effectId: string; reference: string };

export const HOST_COMMAND_OPERATIONS = Object.freeze([
  "execution.status",
  "command.authorize", "command.start", "command.status", "command.inspect",
  "command.adopt", "command.cancel", "command.release", "command.reconcile", "file.reconcile",
] satisfies HostCommandOperation["op"][]);

export type HostOperation =
  | HostMutation
  | HostCommandOperation
  | { op: "discover" }
  | { op: "snapshot"; workspaceId: WorkspaceId }
  | { op: "status"; workspaceId: WorkspaceId; requestId: string };

export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new HostError("invalid_request", "Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function fields(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).some((key) => !expected.includes(key)))
    throw new HostError("invalid_request", "Unknown field");
}

function text(value: unknown, name: string, max = 200): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > max ||
    value.includes("\0")
  )
    throw new HostError("invalid_request", `Invalid ${name}`);
  return value;
}

function identityName(value: unknown, name: string, max = 200): string {
  const result = text(value, name, max);
  if (!isIdentityName(result) || !result.isWellFormed()) throw new HostError("invalid_request", `Invalid ${name}`);
  return result;
}

function workspaceIdentifier(value: unknown): WorkspaceId {
  const result = parseWorkspaceId(text(value, "workspaceId"));
  if (result === undefined) throw new HostError("invalid_request", "Invalid workspaceId");
  return result;
}

function thinkingLevel(value: unknown): ModelThinkingLevel {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      throw new HostError("invalid_request", "Invalid thinkingLevel");
  }
}

function absolute(value: unknown, name: string): string {
  const path = text(value, name, 4095);
  if (!isAbsolute(path) || !path.isWellFormed()) throw new HostError("invalid_request", `${name} must be absolute`);
  return path;
}

export function parseHostConfig(value: unknown): HostConfig {
  const config = object(value);
  fields(config, ["identity", "stateRoot", "model", "thinkingLevel", "authPath", "modelsPath", "execution"]);
  const identity = object(config.identity);
  fields(identity, ["deploymentId", "domain", "nodeId"]);
  if (identity.domain !== "work" && identity.domain !== "personal")
    throw new HostError("invalid_request", "Invalid host domain");
  const model = object(config.model);
  fields(model, ["provider", "modelId"]);
  let execution: HostConfig["execution"];
  if (config.execution !== undefined) {
    const requested = object(config.execution);
    fields(requested, ["mode", "maxRecords"]);
    if (requested.mode !== "durable" || typeof requested.maxRecords !== "number" || !Number.isSafeInteger(requested.maxRecords) || requested.maxRecords < 1 || requested.maxRecords > 65536)
      throw new HostError("invalid_request", "Invalid durable execution configuration");
    execution = Object.freeze({ mode: "durable", maxRecords: requested.maxRecords });
  }
  return {
    identity: {
      deploymentId: identityName(identity.deploymentId, "deploymentId"),
      domain: identity.domain,
      nodeId: identityName(identity.nodeId, "nodeId"),
    },
    stateRoot: absolute(config.stateRoot, "stateRoot"),
    model: { provider: identityName(model.provider, "provider"), modelId: identityName(model.modelId, "modelId") },
    thinkingLevel: thinkingLevel(config.thinkingLevel),
    authPath: absolute(config.authPath, "authPath"),
    modelsPath: absolute(config.modelsPath, "modelsPath"),
    ...(execution === undefined ? {} : { execution }),
  };
}

export async function loadHostConfig(options: {
  readonly path: string;
  readonly expectedSha256: string | undefined;
}): Promise<HostConfig> {
  const file = await open(options.path, "r");
  try {
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size === bytes.length)
      throw new HostError("invalid_config", "Host configuration exceeds byte limit");
    const content = bytes.subarray(0, size);
    if (
      options.expectedSha256 !== undefined &&
      createHash("sha256").update(content).digest("hex") !== options.expectedSha256
    )
      throw new HostError("config_changed", "Host configuration changed; restart Herdr to apply it");
    return parseHostConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)));
  } finally {
    await file.close();
  }
}

function commandParameters(value: unknown): CommandParameters {
  try { return parseCommandParameters(JSON.stringify(object(value))); }
  catch { throw new HostError("invalid_request", "Invalid command parameters"); }
}

function reconciliationContainment(value: unknown): TrustedReconciliation["containment"] {
  const containment = object(value);
  switch (containment.kind) {
    case "manager":
      fields(containment, ["kind"]);
      return { kind: "manager" };
    case "trusted-offline":
      fields(containment, ["kind", "reference"]);
      return { kind: "trusted-offline", reference: identityName(containment.reference, "containment reference", 1024) };
    default:
      throw new HostError("invalid_request", "Invalid reconciliation containment");
  }
}

export function parseOperation(value: unknown): HostOperation {
  const operation = object(value);
  switch (operation.op) {
    case "discover":
      fields(operation, ["op"]);
      return { op: "discover" };
    case "create":
      fields(operation, ["op", "requestId", "workspaceId", "cwd"]);
      return {
        op: "create",
        requestId: identityName(operation.requestId, "requestId"),
        workspaceId: workspaceIdentifier(operation.workspaceId),
        cwd: absolute(operation.cwd, "cwd"),
      };
    case "submit":
      fields(operation, ["op", "requestId", "workspaceId", "content"]);
      return {
        op: "submit",
        requestId: identityName(operation.requestId, "requestId"),
        workspaceId: workspaceIdentifier(operation.workspaceId),
        content: text(operation.content, "content", 64 * 1024),
      };
    case "snapshot":
      fields(operation, ["op", "workspaceId"]);
      return { op: "snapshot", workspaceId: workspaceIdentifier(operation.workspaceId) };
    case "status":
      fields(operation, ["op", "workspaceId", "requestId"]);
      return {
        op: "status",
        workspaceId: workspaceIdentifier(operation.workspaceId),
        requestId: identityName(operation.requestId, "requestId"),
      };
    case "execution.status":
      fields(operation, ["op", "workspaceId"]);
      return { op: "execution.status", workspaceId: workspaceIdentifier(operation.workspaceId) };
    case "command.authorize":
      fields(operation, ["op", "workspaceId", "intentId", "spec"]);
      return {
        op: "command.authorize",
        workspaceId: workspaceIdentifier(operation.workspaceId),
        intentId: identityName(operation.intentId, "intentId", 128),
        spec: commandParameters(operation.spec),
      };
    case "command.start":
    case "command.status":
    case "command.inspect":
    case "command.adopt":
    case "command.cancel":
    case "command.release":
      fields(operation, ["op", "workspaceId", "intentId"]);
      return {
        op: operation.op,
        workspaceId: workspaceIdentifier(operation.workspaceId),
        intentId: identityName(operation.intentId, "intentId", 128),
      };
    case "command.reconcile":
      fields(operation, ["op", "workspaceId", "intentId", "reference", "containment"]);
      return {
        op: "command.reconcile",
        workspaceId: workspaceIdentifier(operation.workspaceId),
        intentId: identityName(operation.intentId, "intentId", 128),
        reference: identityName(operation.reference, "reference", 1024),
        containment: reconciliationContainment(operation.containment),
      };
    case "file.reconcile":
      fields(operation, ["op", "workspaceId", "effectId", "reference"]);
      return {
        op: "file.reconcile",
        workspaceId: workspaceIdentifier(operation.workspaceId),
        effectId: identityName(operation.effectId, "effectId", 128),
        reference: identityName(operation.reference, "reference", 1024),
      };
    default:
      throw new HostError("invalid_request", "Unknown host operation");
  }
}

export function parseEnvelope(value: unknown) {
  const request = object(value);
  fields(request, ["v", "id", "operation"]);
  if (request.v !== HOST_VERSION)
    throw new HostError("protocol_version", "Unsupported host protocol");
  return { id: text(request.id, "transport id"), operation: request.operation };
}

export async function* frames(input: Readable): AsyncGenerator<unknown> {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    if (!(chunk instanceof Buffer)) throw new HostError("invalid_frame", "Expected byte stream");
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      if (pending.length + end - offset > MAX_FRAME_BYTES)
        throw new HostError("frame_too_large", "Host frame exceeds byte limit");
      pending = Buffer.concat([pending, chunk.subarray(offset, end)]);
      offset = end + 1;
      if (newline !== -1) {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(pending);
        pending = Buffer.alloc(0);
        const value: unknown = JSON.parse(decoded);
        yield value;
      }
    }
  }
  if (pending.length !== 0) throw new HostError("invalid_frame", "Truncated host frame");
}

export async function writeFrame(output: Writable, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES)
    throw new HostError("response_too_large", "Host response exceeds byte limit");
  await new Promise<void>((resolve, reject) => {
    output.write(`${encoded}\n`, (error) => (error ? reject(error) : resolve()));
  });
}
