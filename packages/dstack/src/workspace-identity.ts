declare const workspaceId: unique symbol;

export type WorkspaceId = string & { readonly [workspaceId]: "WorkspaceId" };

export function isIdentityName(value: unknown): value is string {
  return typeof value === "string" && value.isWellFormed() && value.trim().length !== 0;
}

export function parseWorkspaceId(value: unknown): WorkspaceId | undefined {
  if (!isIdentityName(value)) return undefined;
  return value as WorkspaceId;
}
