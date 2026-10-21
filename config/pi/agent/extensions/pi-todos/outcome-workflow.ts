import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import {
  freezeOutcome,
  OUTCOME_ENTRY,
  OutcomeQueue,
  outcomeStatus,
  parseOutcomeAction,
  proveOutcome,
  restoreOutcome,
  type Outcome,
} from "./outcome.ts";

type OutcomeContext = Pick<ExtensionContext, "cwd"> & {
  sessionManager: Pick<
    ExtensionContext["sessionManager"],
    "getBranch" | "getSessionId" | "getLeafId"
  >;
};

declare global {
  var dstackOutcomeUncertainSessionsV1: Set<string> | undefined;
}

export class OutcomeWorkflow {
  private readonly queue = new OutcomeQueue();
  private navigation = 0;
  private readonly uncertainSessions = (globalThis.dstackOutcomeUncertainSessionsV1 ??=
    new Set<string>());

  constructor(
    private readonly append: (type: string, data: Outcome) => void,
    private readonly store?: string,
  ) {}

  invalidate(): void {
    this.navigation++;
  }

  status(ctx: OutcomeContext) {
    return this.execute({ action: "status" }, ctx);
  }

  execute(params: unknown, ctx: OutcomeContext, signal?: AbortSignal) {
    const navigation = this.navigation;
    const session = ctx.sessionManager.getSessionId();
    const owned = () => {
      if (this.navigation !== navigation || ctx.sessionManager.getSessionId() !== session)
        throw new Error(
          "Session branch changed during outcome operation. Receipt retained privately, not applied.",
        );
    };
    return this.queue.run(async () => {
      owned();
      const action = parseOutcomeAction(params);
      if (action.action !== "clear" && this.uncertainSessions.has(session))
        throw new Error(
          "Outcome persistence is uncertain. Successfully clear this session before continuing.",
        );
      let current: Outcome =
        action.action === "clear"
          ? { version: 1, kind: "empty" }
          : restoreOutcome(ctx.sessionManager.getBranch());
      const persist = (next: Outcome) => {
        owned();
        try {
          this.append(OUTCOME_ENTRY, next);
        } catch (error) {
          this.uncertainSessions.add(session);
          throw error;
        }
        current = next;
      };
      switch (action.action) {
        case "begin":
        case "amend":
          persist(await freezeOutcome(current, action, ctx.cwd));
          break;
        case "clear":
          persist({ version: 1, kind: "empty" });
          this.uncertainSessions.delete(session);
          break;
        case "block":
          if (current.kind === "empty")
            throw new Error("Begin an outcome before recording a blocker");
          persist({ ...current, attempt: { kind: "blocked", reason: action.reason } });
          break;
        case "prove": {
          if (current.kind === "empty") throw new Error("Begin an outcome before proof");
          if ((await realpath(ctx.cwd)) !== current.workspace)
            throw new Error("Outcome belongs to another workspace");
          const unproved = { ...current, attempt: { kind: "unproved" } } satisfies Outcome;
          persist(unproved);
          const leaf = ctx.sessionManager.getLeafId();
          const next = await proveOutcome(unproved, signal, this.store);
          owned();
          const branch = ctx.sessionManager.getBranch();
          if (leaf === null || !branch.some((entry) => entry.id === leaf))
            throw new Error(
              "Session branch changed during proof. Receipt retained privately, not applied.",
            );
          if (
            branch.findLast(
              (entry) => entry.type === "custom" && entry.customType === OUTCOME_ENTRY,
            )?.id !== leaf
          )
            throw new Error(
              "Outcome changed during proof. Receipt retained privately, not applied.",
            );
          persist(next);
          break;
        }
        case "status":
          break;
        default: {
          const exhaustive: never = action;
          throw new Error(`Unknown outcome action ${exhaustive}`);
        }
      }
      const proof = await outcomeStatus(current, ctx.cwd, this.store);
      owned();
      return { current, proof };
    });
  }
}
