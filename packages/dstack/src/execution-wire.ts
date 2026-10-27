import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { parseCommandEvidence, parseCommandReceipt, parseCommandSpec } from "./command-wire.js";
import { isIdentityName } from "./workspace-identity.js";

const closed = { additionalProperties: false };
const name = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const workspaceName = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const boot = Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" });
const path = Type.String({ pattern: "^/", maxLength: 4095 });
const text = Type.String({ minLength: 1, maxLength: 1024, pattern: "\\S" });
const json = Type.String({ maxLength: 32768 });
const sdk = Type.Object({ taskKey: text, conversationKey: text, callId: text }, closed);
const sdkTask = Type.Object({ kind: Type.Literal("task"), taskKey: text, conversationKey: text }, closed);
const commandSdk = Type.Union([sdk, sdkTask]);
const containment = Type.Object({
  source: Type.Literal("systemd-manager"), unit: Type.String({ pattern: "^hdj-[a-zA-Z0-9.-]+\\.service$", maxLength: 80 }),
  invocationId: Type.String({ pattern: "^[0-9a-f]{32}$" }),
  observedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, closed);
const reconciliation = Type.Union([
  Type.Object({ kind: Type.Literal("manager"), witness: containment }, closed),
  Type.Object({ kind: Type.Literal("trusted-offline"), reference: text }, closed),
]);
const root = Type.Object({
  version: Type.Literal(1), rootId: name, token: hash,
  workspace: Type.Object({
    domain: Type.Union([Type.Literal("personal"), Type.Literal("work")]), nodeId: workspaceName, workspaceId: workspaceName, cwd: path,
  }, closed),
}, closed);
const event = Type.Union([
  Type.Object({ kind: Type.Literal("command.authorized"), specJson: json, specSha256: hash, inputSha256: hash, sourceBootId: boot, captureEpoch: hash }, closed),
  Type.Object({ kind: Type.Literal("command.attempted"), intentId: name, sdk: commandSdk }, closed),
  Type.Object({ kind: Type.Literal("command.activated"), intentId: name, evidenceJson: json }, closed),
  Type.Object({ kind: Type.Literal("command.adopted"), intentId: name, receiptJson: json, containment }, closed),
  Type.Object({ kind: Type.Literal("command.cancel-requested"), intentId: name }, closed),
  Type.Object({ kind: Type.Literal("command.reconciled"), intentId: name, actor: name, reference: text, containment: reconciliation }, closed),
  Type.Object({ kind: Type.Literal("file.started"), effectId: hash, tool: Type.Union([Type.Literal("write"), Type.Literal("edit")]), path, argumentsSha256: hash, sdk }, closed),
  Type.Object({ kind: Type.Literal("file.adopted"), effectId: hash }, closed),
  Type.Object({ kind: Type.Literal("file.reconciled"), effectId: hash, actor: name, reference: text }, closed),
]);
const record = Type.Object({
  version: Type.Literal(1), rootId: name,
  sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), previousSha256: hash, event,
}, closed);

export type ExecutionRoot = Static<typeof root>;
export type ExecutionEvent = Static<typeof event>;
export type ExecutionRecord = Static<typeof record>;
export type RecordedSdkCall = Static<typeof sdk>;
export type RecordedCommandInvocation = Static<typeof commandSdk>;
export const MAX_EXECUTION_RECORD_BYTES = 128 * 1024;

export function executionDigest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parse<T extends TSchema>(schema: T, bytes: string): Static<T> {
  if (!bytes.isWellFormed() || Buffer.byteLength(bytes) > MAX_EXECUTION_RECORD_BYTES)
    throw new Error("Invalid execution evidence encoding or size");
  let value: unknown;
  try { value = JSON.parse(bytes); }
  catch { throw new Error("Invalid execution evidence JSON"); }
  if (!Check(schema, value)) throw new Error("Invalid execution evidence schema");
  return value;
}

function identity(value: string, limit = 128): void {
  if (!isIdentityName(value) || !value.isWellFormed() || value.includes("\0") || Buffer.byteLength(value) > limit)
    throw new Error("Invalid execution identity or reference");
}

function absolutePath(value: string): void {
  if (!value.startsWith("/") || !value.isWellFormed() || value.includes("\0") || Buffer.byteLength(value) > 4095)
    throw new Error("Invalid execution path");
}

export function parseExecutionRoot(bytes: string): ExecutionRoot {
  const value = parse(root, bytes);
  identity(value.rootId);
  for (const id of [value.workspace.nodeId, value.workspace.workspaceId]) identity(id, 200);
  absolutePath(value.workspace.cwd);
  return value;
}

export function executionRootBytes(value: ExecutionRoot): string {
  return JSON.stringify({
    version: value.version, rootId: value.rootId, token: value.token,
    workspace: { domain: value.workspace.domain, nodeId: value.workspace.nodeId, workspaceId: value.workspace.workspaceId, cwd: value.workspace.cwd },
  });
}

function call(value: RecordedCommandInvocation): void {
  for (const key of [value.taskKey, value.conversationKey]) identity(key, 1024);
  if ("callId" in value) identity(value.callId, 1024);
}

function embedded(value: ExecutionEvent, root: ExecutionRoot): void {
  if ("intentId" in value) identity(value.intentId);
  if ("actor" in value) identity(value.actor);
  if ("reference" in value) identity(value.reference, 1024);
  switch (value.kind) {
    case "command.authorized": {
      const spec = parseCommandSpec(value.specJson);
      if (executionDigest(value.specJson) !== value.specSha256 || spec.workspaceId !== root.workspace.workspaceId || spec.cwd !== root.workspace.cwd)
        throw new Error("Authorized command differs from execution root");
      break;
    }
    case "command.attempted": call(value.sdk); break;
    case "command.activated": {
      const evidence = parseCommandEvidence(value.evidenceJson);
      if (evidence.workspaceId !== root.workspace.workspaceId || evidence.intentId !== value.intentId)
        throw new Error("Command activation differs from execution root");
      break;
    }
    case "command.adopted": {
      const receipt = parseCommandReceipt(value.receiptJson);
      if (receipt.evidence.workspaceId !== root.workspace.workspaceId
        || receipt.evidence.intentId !== value.intentId || value.containment.unit !== receipt.evidence.activation.unit
        || value.containment.invocationId !== receipt.evidence.activation.invocationId)
        throw new Error("Command adoption differs from original activation");
      break;
    }
    case "command.reconciled":
      if (value.containment.kind === "trusted-offline") identity(value.containment.reference, 1024);
      break;
    case "command.cancel-requested": break;
    case "file.started": {
      absolutePath(value.path); call(value.sdk);
      const local = relative(root.workspace.cwd, value.path);
      if (local === ".." || local.startsWith("../") || isAbsolute(local)) throw new Error("File effect escapes execution workspace");
      break;
    }
    case "file.adopted": break;
    case "file.reconciled": break;
    default: {
      const exhaustive: never = value;
      throw new Error(`Unsupported execution event ${exhaustive}`);
    }
  }
}

export function parseExecutionEvent(bytes: string, root: ExecutionRoot): ExecutionEvent {
  const value = parse(event, bytes);
  embedded(value, root);
  return value;
}

export function parseExecutionRecord(bytes: string, root: ExecutionRoot): ExecutionRecord {
  const value = parse(record, bytes);
  if (value.rootId !== root.rootId) throw new Error("Execution record root differs");
  embedded(value.event, root);
  return value;
}
