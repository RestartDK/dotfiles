import { randomBytes } from "node:crypto";
import type { Cursor } from "@earendil-works/pi-durable";
import type { HostIdentity } from "#host-protocol";
import type { WorkspaceId } from "./workspace-identity.js";
import { CLIENT_RESOURCES } from "#client-wire";

export class ClientCursorError extends Error {
  readonly code = "cursor_expired";
  constructor() { super("Client history cursor expired or belongs to another attachment; request the first page"); }
}

type Scope = { readonly principalId: string; readonly workspaceId: WorkspaceId; readonly conversationId: string };

export class ClientHistory {
  readonly #epoch = randomBytes(16).toString("hex");
  readonly #cursors = new Map<string, { readonly binding: string; readonly cursor: Cursor; readonly expires: number }>();
  constructor(private readonly identity: HostIdentity) {}

  private binding(scope: Scope): string {
    return JSON.stringify([this.identity.deploymentId, this.identity.domain, this.identity.nodeId, scope.principalId, scope.workspaceId, scope.conversationId, "entries-descending-20.v1", this.#epoch]);
  }

  read(token: string | undefined, scope: Scope): Cursor | undefined {
    if (token === undefined) return undefined;
    const stored = this.#cursors.get(token);
    if (stored === undefined || stored.expires <= Date.now() || stored.binding !== this.binding(scope)) throw new ClientCursorError();
    return stored.cursor;
  }

  seal(cursor: Cursor | undefined, scope: Scope): string | undefined {
    if (cursor === undefined) return undefined;
    const now = Date.now();
    for (const [token, stored] of this.#cursors) if (stored.expires <= now) this.#cursors.delete(token);
    while (this.#cursors.size >= CLIENT_RESOURCES.cursorSlots) {
      const oldest = this.#cursors.keys().next();
      if (oldest.done) break;
      this.#cursors.delete(oldest.value);
    }
    const token = `hc1.${this.#epoch}.${randomBytes(32).toString("base64url")}`;
    this.#cursors.set(token, { binding: this.binding(scope), cursor, expires: now + CLIENT_RESOURCES.cursorMs });
    return token;
  }
}
