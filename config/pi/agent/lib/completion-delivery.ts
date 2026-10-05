import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Attempt } from "../extensions/pi-coordination/core.ts";

export type CompletionOrigin = { sessionId: string; userEntryId: string | null };
export type CompletionReceipt =
  | { kind: "herdr"; paneId: string; runId: string; outcome: "done" | "closed" | "expired" }
  | ({ kind: "coordination" } & Pick<Attempt, "id" | "finishedAt" | "state" | "outcome">);
export type CompletionDelivery = "wake" | "record";
type Session = Pick<ExtensionContext["sessionManager"], "getBranch" | "getSessionId">;
type Branch = ReturnType<Session["getBranch"]>;

export function completionOrigin(session: Session): CompletionOrigin {
  const branch = session.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type === "message" && entry.message.role === "user") {
      return { sessionId: session.getSessionId(), userEntryId: entry.id };
    }
  }
  return { sessionId: session.getSessionId(), userEntryId: null };
}

function parseReceipt(kind: CompletionReceipt["kind"], details: unknown): CompletionReceipt | null {
  if (typeof details !== "object" || details === null) return null;
  if (kind === "herdr") {
    if (
      !("paneId" in details) ||
      typeof details.paneId !== "string" ||
      !("runId" in details) ||
      typeof details.runId !== "string"
    )
      return null;
    const outcome =
      "kind" in details && details.kind === "expired"
        ? "expired"
        : "kind" in details && details.kind === "closed"
          ? "closed"
          : "done";
    return { kind, paneId: details.paneId, runId: details.runId, outcome };
  }
  if (!("attempt" in details) || typeof details.attempt !== "object" || details.attempt === null)
    return null;
  const attempt = details.attempt;
  if (
    !("id" in attempt) ||
    typeof attempt.id !== "string" ||
    !("finishedAt" in attempt) ||
    typeof attempt.finishedAt !== "string" ||
    !("state" in attempt) ||
    (attempt.state !== "settled" && attempt.state !== "blocked") ||
    !("outcome" in attempt) ||
    (attempt.outcome !== "completed" &&
      attempt.outcome !== "failed" &&
      attempt.outcome !== "cancelled" &&
      attempt.outcome !== "unknown")
  )
    return null;
  return {
    kind,
    id: attempt.id,
    finishedAt: attempt.finishedAt,
    state: attempt.state,
    outcome: attempt.outcome,
  };
}

export class CompletionReceipts {
  private readonly consumed = new Set<string>();

  constructor(private readonly kind: CompletionReceipt["kind"]) {}

  private key(receipt: CompletionReceipt): string {
    switch (receipt.kind) {
      case "herdr":
        return `herdr\0${receipt.paneId}\0${receipt.runId}\0${receipt.outcome}`;
      case "coordination":
        return `coordination\0${receipt.id}\0${receipt.finishedAt}\0${receipt.state}\0${receipt.outcome}`;
      default: {
        const exhaustive: never = receipt;
        throw new Error(`Unknown receipt ${exhaustive}`);
      }
    }
  }

  consume(receipt: CompletionReceipt): boolean {
    const key = this.key(receipt);
    const fresh = !this.consumed.has(key);
    this.consumed.add(key);
    return fresh;
  }

  restore(branch: Branch): void {
    this.consumed.clear();
    for (const entry of branch) {
      let details: unknown;
      if (
        entry.type === "custom_message" &&
        (entry.customType ===
          (this.kind === "herdr" ? "herdr-run-finished" : "coordination-result") ||
          (this.kind === "coordination" && entry.customType === "coordination-status"))
      )
        details = entry.details;
      else if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === (this.kind === "herdr" ? "herdr" : "coordinate")
      ) {
        details = entry.message.details;
        if (
          this.kind === "herdr" &&
          (typeof details !== "object" ||
            details === null ||
            !("state" in details) ||
            details.state !== "done")
        )
          continue;
      } else continue;
      if (
        this.kind === "coordination" &&
        typeof details === "object" &&
        details !== null &&
        "attempts" in details &&
        Array.isArray(details.attempts)
      ) {
        for (const attempt of details.attempts) {
          const receipt = parseReceipt("coordination", { attempt });
          if (receipt) this.consume(receipt);
        }
      } else {
        const receipt = parseReceipt(this.kind, details);
        if (receipt) this.consume(receipt);
      }
    }
  }

  deliver({
    receipt,
    origin,
    current,
    publish,
  }: {
    receipt: CompletionReceipt;
    origin: CompletionOrigin;
    current: CompletionOrigin;
    publish: (delivery: CompletionDelivery) => void;
  }): "delivered" | "ignored" {
    if (origin.sessionId !== current.sessionId) return "ignored";
    const key = this.key(receipt);
    if (!this.consume(receipt)) return "ignored";
    try {
      publish(origin.userEntryId === current.userEntryId ? "wake" : "record");
    } catch (error) {
      this.consumed.delete(key);
      throw error;
    }
    return "delivered";
  }
}
