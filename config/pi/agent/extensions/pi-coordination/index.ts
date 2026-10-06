import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolve } from "node:path";
import { CompletionReceipts, completionOrigin } from "../../lib/completion-delivery.ts";
import {
  cancelAttempt,
  describe,
  describeHolder,
  describeLease,
  listAttempts,
  listLeases,
  POLL_MS,
  resolveBlocked,
  startDetached,
  stateDirectory,
  tail,
  watch,
  type JobSpec,
} from "./core.ts";

export default function coordination(pi: ExtensionAPI): void {
  const watching = new Map<string, AbortController>();
  const receipts = new CompletionReceipts("coordination");
  const root = stateDirectory();
  let active = true;
  let activeContext: ExtensionContext | undefined;

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    receipts.restore(ctx.sessionManager.getBranch());
  });
  pi.on("session_tree", (_event, ctx) => {
    activeContext = ctx;
    receipts.restore(ctx.sessionManager.getBranch());
  });

  function status(root: string) {
    const leases = listLeases(root);
    const attempts = listAttempts(root, 10);
    for (const attempt of attempts) receipts.consume({ ...attempt, kind: "coordination" });
    return {
      content:
        [...leases.map(describeLease), ...attempts.map(describe)].join("\n") ||
        "No retained attempts",
      leases,
      attempts,
    };
  }

  function watchAttempt(root: string, id: string, ctx: ExtensionContext): void {
    if (watching.has(id)) return;
    const controller = new AbortController();
    watching.set(id, controller);
    activeContext = ctx;
    const origin = completionOrigin(ctx.sessionManager);
    const owner = origin.sessionId;
    ctx.ui.setStatus("coordination", `coord: ${watching.size} waiting`);
    const poll = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const state = watch(root, id);
        if (state.kind === "settled") {
          if (!active || controller.signal.aborted || !activeContext) return;
          receipts.deliver({
            receipt: { ...state.attempt, kind: "coordination" },
            origin,
            current: completionOrigin(activeContext.sessionManager),
            publish(delivery) {
              pi.sendMessage(
                {
                  customType: "coordination-result",
                  display: true,
                  content: `Coordinator result for ${id}:\n${describe(state.attempt)}\n${state.attempt.state === "blocked" ? (state.attempt.reason ?? "The key is still held") : "Use the coordinate tool with this id to read the log tail."}`,
                  details: { id, owner, attempt: state.attempt },
                },
                { triggerTurn: delivery === "wake", deliverAs: "followUp" },
              );
            },
          });
          return;
        }
        if (state.kind === "missing") {
          activeContext?.ui.notify(`Attempt ${id} is not present in ${root}`, "warning");
          return;
        }
        await new Promise((done) => setTimeout(done, POLL_MS));
      }
    };
    void poll()
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted && activeContext)
          activeContext.ui.notify(
            `Coordinator watch ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
      })
      .finally(() => {
        if (watching.get(id) === controller) watching.delete(id);
        if (active && activeContext)
          activeContext.ui.setStatus(
            "coordination",
            watching.size ? `coord: ${watching.size} waiting` : undefined,
          );
      });
  }

  pi.on("session_shutdown", () => {
    active = false;
    for (const controller of watching.values()) controller.abort();
    watching.clear();
  });

  pi.registerCommand("coord", {
    description: "Show held resources, watch one attempt, or resolve an inspected blocked key",
    async handler(args, ctx) {
      const [action, id] = args.trim().split(/\s+/);
      if (action === "watch" && id) {
        watchAttempt(root, id, ctx);
        ctx.ui.notify(`Watching ${id}. Closing Pi does not cancel the command.`, "info");
        return;
      }
      if (action === "resolve" && id) {
        if (
          !ctx.hasUI ||
          !(await ctx.ui.confirm(
            "Release blocked resource?",
            `Confirm you inspected the resource and every process for ${id}. The outcome stays unknown.`,
          ))
        )
          return;
        ctx.ui.notify(describe(resolveBlocked(root, id, { inspected: true })), "info");
        return;
      }
      if (action && action !== "status")
        throw new Error("Usage: /coord [status | watch ID | resolve ID]");
      const observed = status(root);
      pi.sendMessage(
        {
          customType: "coordination-status",
          content: observed.content,
          display: true,
          details: { leases: observed.leases, attempts: observed.attempts },
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerTool({
    name: "coordinate",
    label: "Coordinate",
    description:
      "Take an exclusive lease for one bounded command on a genuinely shared resource, then inspect, watch, cancel, or resolve an owned attempt. Prefer separate writable checkouts. Never hold a lease across approval waits, CI waits, or a manual release FIFO. Unknown outcomes stay blocked until inspection and confirmed process-group absence; resolution does not turn unknown into success.",
    promptSnippet:
      "Prefer separate writable checkouts; lease a genuinely shared resource for one bounded mutation",
    promptGuidelines: [
      "Eliminate shared writable state first. For an unavoidable shared device, checkout mutation, or build target, use the same resource key other agents use.",
      "Only cancel or resolve your own attempt. Ask the owner for a bounded transfer; operator-confirmed /coord resolve handles inspected recovery across sessions.",
      "Prefer one key per real resource. Reuse the attempt id when a submission is uncertain, since a fresh id can run the command twice.",
      "A lease is not permission to flash, deploy, or merge. Those approvals stay separate.",
    ],
    parameters: Type.Object({
      action: StringEnum(["submit", "status", "watch", "cancel", "resolve"] as const),
      inspected: Type.Optional(
        Type.Boolean({
          description:
            "For resolve: confirms inspection of the resource, process group, and recorded outcome. Only owned attempts may be resolved by the tool.",
        }),
      ),
      id: Type.Optional(
        Type.String({ description: "Attempt id; reuse it to retry an uncertain submission" }),
      ),
      resource: Type.Optional(
        Type.String({ description: "Shared key, such as device:x4 or worktree:/abs/path" }),
      ),
      label: Type.Optional(Type.String()),
      revision: Type.Optional(
        Type.String({ description: "Commit or artifact label, recorded not verified" }),
      ),
      cwd: Type.Optional(Type.String()),
      command: Type.Optional(
        Type.Array(Type.String(), { description: "Executable and arguments; no implicit shell" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action !== "submit" && params.action !== "status" && params.id === undefined)
        throw new Error(`${params.action} needs an attempt id`);
      if (params.action === "status" && params.id === undefined) {
        const observed = status(root);
        return {
          content: [{ type: "text", text: observed.content }],
          details: { leases: observed.leases, attempts: observed.attempts },
        };
      }
      const id = params.id ?? `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      if (params.action === "status") {
        const observed = watch(root, id);
        if (observed.kind === "missing")
          return {
            content: [{ type: "text", text: `No attempt ${id} is present` }],
            details: { id },
          };
        const output = tail(root, id);
        if (observed.kind === "running") {
          return {
            content: [
              {
                type: "text",
                text: `${describeHolder(observed.holder)}${output ? `\n${output}` : ""}`,
              },
            ],
            details: { id, holder: observed.holder },
          };
        }
        const attempt = observed.attempt;
        receipts.consume({ ...attempt, kind: "coordination" });
        return {
          content: [{ type: "text", text: `${describe(attempt)}${output ? `\n${output}` : ""}` }],
          details: { id, attempt },
        };
      }
      if (params.action === "watch") {
        watchAttempt(root, id, ctx);
        return {
          content: [
            { type: "text", text: `Watching ${id}. Closing Pi does not cancel the command.` },
          ],
          details: { id },
        };
      }
      if (params.action === "cancel" || params.action === "resolve") {
        const observed = watch(root, id);
        if (observed.kind === "missing")
          return {
            content: [{ type: "text", text: `No attempt ${id} holds a resource` }],
            details: { id },
          };
        const owner = observed.kind === "running" ? observed.holder.owner : observed.attempt.owner;
        if (owner !== ctx.sessionManager.getSessionId())
          throw new Error(
            `Attempt ${id} belongs to session ${owner}. Ask its owner for a bounded transfer or use operator-confirmed /coord resolve after inspection.`,
          );
        if (params.action === "resolve") {
          const attempt = resolveBlocked(root, id, { inspected: params.inspected === true });
          receipts.consume({ ...attempt, kind: "coordination" });
          return { content: [{ type: "text", text: describe(attempt) }], details: { id, attempt } };
        }
        const result = cancelAttempt(root, id);
        if (result.kind === "settled")
          receipts.consume({ ...result.attempt, kind: "coordination" });
        if (result.kind === "missing")
          return {
            content: [{ type: "text", text: `No attempt ${id} holds a resource` }],
            details: { id },
          };
        const text =
          result.kind === "cancelled"
            ? `Cancellation sent for ${id}; the key stays held until the group exits`
            : describe(result.attempt);
        return { content: [{ type: "text", text }], details: result };
      }
      if (params.resource === undefined || params.command === undefined) {
        throw new Error("submit needs a resource and a command");
      }
      const job: JobSpec = {
        resource: params.resource,
        id,
        owner: ctx.sessionManager.getSessionId(),
        label: params.label ?? "unspecified",
        revision: params.revision ?? "unversioned",
        cwd: resolve(ctx.cwd, params.cwd ?? "."),
        command: params.command,
      };
      const started = await startDetached(root, job);
      if (started.kind === "started") {
        watchAttempt(root, id, ctx);
        return {
          content: [
            {
              type: "text",
              text: `${describeHolder(started.holder)}\nAttempt id ${id}; keep it for any retry.`,
            },
          ],
          details: started,
        };
      }
      if (started.kind === "existing") {
        receipts.consume({ ...started.attempt, kind: "coordination" });
        return {
          content: [
            { type: "text", text: `Attempt ${id} already exists:\n${describe(started.attempt)}` },
          ],
          details: started,
        };
      }
      if (started.kind === "failed") {
        receipts.consume({ ...started.attempt, kind: "coordination" });
        return { content: [{ type: "text", text: describe(started.attempt) }], details: started };
      }
      const reason =
        started.state.kind === "blocked" ? started.state.reason : "held by another attempt";
      return {
        content: [{ type: "text", text: `${job.resource} is not available: ${reason}` }],
        details: started,
      };
    },
  });
}
