import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const HANDOFF_ENTRY = "pi-herdr-worktree-v1";
export const EnterParameters = Type.Object({
  branch: Type.String({
    minLength: 1,
    description: "Task branch, prefixed with daniel/ if unqualified",
  }),
  base: Type.Optional(Type.String()),
  path: Type.Optional(
    Type.String({ description: "Optional absolute checkout path with a short slug" }),
  ),
  label: Type.Optional(Type.String()),
});
export type EnterRequest = Static<typeof EnterParameters>;

const Request = Type.Object({
  id: Type.String(),
  sourceSessionId: Type.String(),
  sourceSessionFile: Type.String(),
  request: EnterParameters,
});
const Destination = Type.Object({
  path: Type.String(),
  workspaceId: Type.String(),
  paneId: Type.String(),
  claimPath: Type.String(),
});
const State = Type.Union([
  Type.Object({ kind: Type.Literal("requested"), ...Request.properties }),
  Type.Object({
    kind: Type.Union([
      Type.Literal("launching"),
      Type.Literal("transferred"),
      Type.Literal("owned"),
    ]),
    ...Request.properties,
    destination: Destination,
  }),
  Type.Object({
    kind: Type.Literal("stopped"),
    ...Request.properties,
    reason: Type.String(),
    destination: Type.Union([Destination, Type.Null()]),
  }),
]);
export type HandoffRequest = Static<typeof Request>;
export type HandoffDestination = Static<typeof Destination>;
export type WorktreeState = Static<typeof State>;

export function worktreeState(branch: SessionEntry[]): WorktreeState | undefined {
  const entry = branch
    .slice()
    .reverse()
    .find((entry) => entry.type === "custom" && entry.customType === HANDOFF_ENTRY);
  if (!entry || entry.type !== "custom") return undefined;
  const data: unknown = entry.data;
  if (!Check(State, data))
    throw new Error("Invalid saved worktree handoff state. Use /tree or /new to recover.");
  return data;
}

export function handoffBlock(
  session: Pick<ExtensionContext["sessionManager"], "getBranch" | "getSessionId">,
  cwd: string,
): string | undefined {
  const state = worktreeState(session.getBranch());
  if (!state) return undefined;
  if (
    state.kind === "owned" &&
    state.id === session.getSessionId() &&
    state.destination.path === cwd
  )
    return undefined;
  const destination =
    "destination" in state && state.destination ? ` Inspect pane ${state.destination.paneId}.` : "";
  const recovery =
    "destination" in state && state.destination
      ? "Use the destination session, or /tree or /new to recover."
      : "No destination was started. Use /tree or /new to recover.";
  return `This branch has a ${state.kind} worktree handoff.${destination} ${recovery} It will not restart automatically.`;
}

export class HandoffReadiness {
  readonly path: string;
  readonly id: string;

  constructor(claimPath: string, id: string) {
    this.path = join(claimPath, "decision");
    this.id = id;
  }

  async read(): Promise<"ready" | "stopped" | undefined> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (content === `ready:${this.id}`) return "ready";
    if (content === "stopped") return "stopped";
    throw new Error(
      `Invalid handoff readiness at ${this.path}. Inspect the destination before recovery.`,
    );
  }

  async decide(decision: "ready" | "stopped"): Promise<"ready" | "stopped"> {
    const candidate = `${this.path}-${randomUUID()}`;
    await writeFile(candidate, decision === "ready" ? `ready:${this.id}` : "stopped", {
      flag: "wx",
    });
    try {
      await link(candidate, this.path);
      return decision;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const winner = await this.read();
      if (!winner) throw new Error(`Handoff decision disappeared at ${this.path}.`);
      return winner;
    } finally {
      await unlink(candidate);
    }
  }

  async wait(timeoutMs = 60_000, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      signal?.throwIfAborted();
      const decision = await this.read();
      if (decision === "ready") return;
      if (decision === "stopped")
        throw new Error(`Handoff stopped. Inspect the reservation at ${this.path}.`);
      if (Date.now() >= deadline) {
        if ((await this.decide("stopped")) === "ready") return;
        throw new Error(
          `Pi did not acknowledge readiness. Inspect the destination pane and reservation at ${this.path} before recovery.`,
        );
      }
      await delay(250, undefined, { signal });
    }
  }
}
