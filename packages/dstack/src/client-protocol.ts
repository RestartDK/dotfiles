import { clientIdentifier, clientObject, clientText, clientWorkspaceId, ClientError, type ClientPermission } from "#client-authority";
import type { WorkspaceId } from "./workspace-identity.js";

export const CLIENT_VERSION = 1;
export const MAX_CLIENT_REQUEST_BYTES = 128 * 1024;
export const MAX_CLIENT_EVENT_BYTES = 8 * 1024 * 1024;

export type ClientOperation =
  | { readonly op: "discover" }
  | { readonly op: "open" | "watch" | "abort" | "execution.status"; readonly workspaceId: WorkspaceId }
  | { readonly op: "snapshot"; readonly workspaceId: WorkspaceId; readonly cursor?: string }
  | { readonly op: "submit"; readonly workspaceId: WorkspaceId; readonly requestId: string; readonly content: string }
  | { readonly op: "status"; readonly workspaceId: WorkspaceId; readonly requestId: string }
  | { readonly op: "command.cancel"; readonly workspaceId: WorkspaceId; readonly intentId: string };

export type ClientEnvelope = { readonly v: 1; readonly id: string; readonly operation: ClientOperation };

export function parseClientOperation(value: unknown): ClientOperation {
  const operation = clientObject(value, ["op", "workspaceId", "requestId", "content", "cursor", "intentId"]);
  switch (operation.op) {
    case "discover":
      clientObject(operation, ["op"]);
      return { op: "discover" };
    case "open": case "watch": case "abort": case "execution.status":
      clientObject(operation, ["op", "workspaceId"]);
      return { op: operation.op, workspaceId: clientWorkspaceId(operation.workspaceId) };
    case "snapshot":
      clientObject(operation, ["op", "workspaceId", "cursor"]);
      return { op: "snapshot", workspaceId: clientWorkspaceId(operation.workspaceId), ...(operation.cursor === undefined ? {} : { cursor: clientText(operation.cursor, 4096) }) };
    case "submit":
      clientObject(operation, ["op", "workspaceId", "requestId", "content"]);
      return { op: "submit", workspaceId: clientWorkspaceId(operation.workspaceId), requestId: clientIdentifier(operation.requestId), content: clientText(operation.content, 64 * 1024) };
    case "status":
      clientObject(operation, ["op", "workspaceId", "requestId"]);
      return { op: "status", workspaceId: clientWorkspaceId(operation.workspaceId), requestId: clientIdentifier(operation.requestId) };
    case "command.cancel":
      clientObject(operation, ["op", "workspaceId", "intentId"]);
      return { op: "command.cancel", workspaceId: clientWorkspaceId(operation.workspaceId), intentId: clientIdentifier(operation.intentId, 128) };
    default:
      throw new ClientError("invalid_request", "Unknown client operation");
  }
}

export function parseClientEnvelope(value: unknown): ClientEnvelope {
  const envelope = clientObject(value, ["v", "id", "operation"]);
  if (envelope.v !== CLIENT_VERSION) throw new ClientError("invalid_request", "Unsupported client protocol");
  return { v: CLIENT_VERSION, id: clientIdentifier(envelope.id, 128), operation: parseClientOperation(envelope.operation) };
}

export function clientPermission(operation: ClientOperation): ClientPermission | undefined {
  switch (operation.op) {
    case "discover": return undefined;
    case "status": case "snapshot": case "watch": case "execution.status": return "read";
    case "open": case "submit": return "submit";
    case "abort": return "abort";
    case "command.cancel": return "command.cancel";
    default: { const exhaustive: never = operation; throw new Error(`Unsupported client operation ${exhaustive}`); }
  }
}
