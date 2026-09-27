import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { resolve } from "node:path";
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
  watch,
  type JobSpec,
} from "./core.ts";

export default function coordination(pi: ExtensionAPI): void {
  const watching = new Map<string, AbortController>();
  let active = true;

  function status(root: string): string {
    const leases = listLeases(root).map(describeLease);
    const attempts = listAttempts(root, 10).map(describe);
    return [...leases, ...attempts].join("\n") || "No retained attempts";
  }

  function watchAttempt(root: string, id: string, ctx: ExtensionContext): void {
    if (watching.has(id)) return;
    const controller = new AbortController();
    watching.set(id, controller);
    const owner = ctx.sessionManager.getSessionId();
    ctx.ui.setStatus("coordination", `coord: ${watching.size} waiting`);
    const poll = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const state = watch(root, id);
        if (state.kind === "settled") {
          if (!active || controller.signal.aborted) return;
          pi.sendMessage(
            {
              customType: "coordination-result",
              display: true,
              content: `Coordinator result for ${id}:\n${describe(state.attempt)}\n${state.attempt.state === "blocked" ? (state.attempt.reason ?? "The key is still held") : "Use the coordinate tool with this id to read the log tail."}`,
              details: { id, owner, attempt: state.attempt },
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
          return;
        }
        if (state.kind === "missing") {
          ctx.ui.notify(`Attempt ${id} is not present in ${root}`, "warning");
          return;
        }
        await new Promise((done) => setTimeout(done, POLL_MS));
      }
    };
    void poll().finally(() => {
      watching.delete(id);
      if (active)
        ctx.ui.setStatus(
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
      const root = stateDirectory();
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
        ctx.ui.notify(describe(resolveBlocked(root, id, true)), "info");
        return;
      }
      if (action && action !== "status")
        throw new Error("Usage: /coord [status | watch ID | resolve ID]");
      pi.sendMessage(
        { customType: "coordination-status", content: status(root), display: true },
        { triggerTurn: false },
      );
    },
  });

  pi.registerTool({
    name: "coordinate",
    label: "Coordinate",
    description:
      "Take an exclusive lease on a shared resource for one command, then queue, watch, or cancel it. Use it for a device, a checkout, or a build target that other agents may touch at the same time. A command that leaves descendants behind keeps its key blocked until someone inspects it and resolves it.",
    promptSnippet: "Take an exclusive lease on a shared resource before using it",
    promptGuidelines: [
      "Take a lease before touching a shared device, checkout, or build target, and use the same key other agents use.",
      "Prefer one key per real resource. Reuse the attempt id when a submission is uncertain, since a fresh id can run the command twice.",
      "A lease is not permission to flash, deploy, or merge. Those approvals stay separate.",
    ],
    parameters: Type.Object({
      action: StringEnum(["submit", "status", "watch", "cancel"] as const),
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
      const root = stateDirectory();
      if (params.action === "status" && params.id === undefined) {
        return {
          content: [{ type: "text", text: status(root) }],
          details: { leases: listLeases(root) },
        };
      }
      const id = params.id ?? `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      if (params.action === "watch") {
        watchAttempt(root, id, ctx);
        return {
          content: [
            { type: "text", text: `Watching ${id}. Closing Pi does not cancel the command.` },
          ],
          details: { id },
        };
      }
      if (params.action === "cancel") {
        const result = cancelAttempt(root, id);
        if (result.kind === "missing")
          return { content: [{ type: "text", text: `No attempt ${id} holds a resource` }] };
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
        return {
          content: [
            { type: "text", text: `Attempt ${id} already exists:\n${describe(started.attempt)}` },
          ],
          details: started,
        };
      }
      if (started.kind === "failed") {
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
