import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isAbsolute, resolve } from "node:path";

import { expectResult, HerdrRequestError, type HerdrClient } from "./client.ts";
import {
  canonicalPath,
  claimCheckout,
  ensureWorktree,
  releaseCheckout,
  type CheckoutClaim,
  type WorktreeWorkspace,
} from "./worktree.ts";
import { observePaneForeground } from "./pane-foreground.ts";
import {
  EnterParameters,
  HANDOFF_ENTRY,
  HandoffReadiness,
  handoffBlock,
  worktreeState,
  type EnterRequest,
  type HandoffRequest,
  type HandoffDestination,
  type WorktreeState,
} from "./worktree-state.ts";

export interface WorktreeParentResolution {
  workspaceId: string | undefined;
  cwd: string | undefined;
  checkoutCwd?: string;
}

export interface WorktreeHandoffDeps {
  observeForeground?: typeof observePaneForeground;
  herdr: Pick<HerdrClient, "call">;
  currentPaneTarget: string;
  resolveWorktreeParent: (
    workspaceRef: string | undefined,
    explicitCwd: string | undefined,
    requestCwd: string,
    currentWorkspaceId: string,
    signal?: AbortSignal,
  ) => Promise<WorktreeParentResolution>;
}

export function worktreeBranchFromArg(arg: string): string {
  const branch = arg.trim();
  return branch.includes("/") ? branch : `daniel/${branch}`;
}

type LaunchPhase =
  | { kind: "preparing" }
  | { kind: "reserved"; claim: CheckoutClaim; destination: HandoffDestination }
  | { kind: "submitted"; claim: CheckoutClaim; destination: HandoffDestination };

export function handoffResourceArgs(argv: string[], cwd: string): string[] {
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (
      [
        "-ne",
        "--no-extensions",
        "-ns",
        "--no-skills",
        "-nc",
        "--no-context-files",
        "-nt",
        "--no-tools",
        "-nbt",
        "--no-builtin-tools",
        "-a",
        "--approve",
        "-na",
        "--no-approve",
      ].includes(arg)
    )
      args.push(arg);
    if (["-t", "--tools", "-xt", "--exclude-tools"].includes(arg) && argv[i + 1] !== undefined) {
      args.push(arg, argv[++i]);
      continue;
    }
    if (
      [
        "--provider",
        "--model",
        "--api-key",
        "--system-prompt",
        "--append-system-prompt",
        "--name",
        "-n",
        "--session",
        "--session-id",
        "--fork",
        "--session-dir",
        "--models",
        "--thinking",
        "--export",
        "--skill",
        "--prompt-template",
        "--theme",
      ].includes(arg) &&
      argv[i + 1] !== undefined
    ) {
      i++;
      continue;
    }
    if (
      ["--mode", "--use-theme", "--tui-mode"].includes(arg) &&
      argv[i + 1] !== undefined &&
      !argv[i + 1].startsWith("-")
    ) {
      i++;
      continue;
    }
    if (["-e", "--extension"].includes(arg) && argv[i + 1] !== undefined) {
      const path = argv[++i];
      args.push(arg, path.startsWith("builtin:") || isAbsolute(path) ? path : resolve(cwd, path));
    }
  }
  return args;
}

export function buildPiHandoffCommand(options: {
  sessionFile: string;
  sessionName: string | undefined;
  successorId: string;
  model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;
  thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  resourceArgs: string[];
}): string {
  const direnvPrelude =
    'if [ -f .envrc ] && command -v direnv >/dev/null 2>&1; then direnv allow . >/dev/null 2>&1; eval "$(direnv export bash 2>/dev/null)"; fi;';
  const args = [
    "pi",
    ...options.resourceArgs,
    "--fork",
    options.sessionFile,
    "--session-id",
    options.successorId,
    "--provider",
    options.model.provider,
    "--model",
    options.model.id,
    "--thinking",
    options.thinking,
  ];
  const name = options.sessionName?.trim();
  if (name) args.push("--name", name);
  args.push("--", `/worktree-continue ${options.successorId}`);
  return `${direnvPrelude} ${args.map(shellQuote).join(" ")}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handoffPane(
  herdr: Pick<HerdrClient, "call">,
  checkout: WorktreeWorkspace,
  sourcePaneId: string,
  sourceSessionFile: string,
  signal?: AbortSignal,
  id: string = randomUUID(),
  observeForeground: typeof observePaneForeground = observePaneForeground,
): Promise<{ pane: WorktreeWorkspace["root_pane"]; claim: CheckoutClaim }> {
  const assertAvailable = async (previous?: HandoffDestination) => {
    const workspaces = expectResult(
      await herdr.call("workspace.list", {}, { timeoutMs: 5000, signal }),
      "workspace_list",
    ).workspaces;
    for (const workspace of workspaces) {
      const panes = expectResult(
        await herdr.call(
          "pane.list",
          { workspace_id: workspace.workspace_id },
          { timeoutMs: 5000, signal },
        ),
        "pane_list",
      ).panes;
      for (const pane of panes) {
        if (!pane.agent && pane.pane_id !== sourcePaneId) continue;
        const paths = await Promise.all(
          [pane.foreground_cwd, pane.cwd, workspace.worktree?.checkout_path]
            .filter((path): path is string => !!path)
            .map((path) => canonicalPath(path)),
        );
        const inCheckout = paths.some(
          (path) =>
            path === checkout.worktree.path || path.startsWith(`${checkout.worktree.path}/`),
        );
        if (
          (workspace.workspace_id === checkout.workspace.workspace_id || inCheckout) &&
          (pane.agent || pane.pane_id === sourcePaneId)
        )
          throw new Error(
            `The target checkout already has an agent in ${pane.pane_id}. Use that session or choose another branch.`,
          );
      }
    }
    if (previous) {
      try {
        const target = expectResult(
          await herdr.call("pane.get", { pane_id: previous.paneId }, { timeoutMs: 5000, signal }),
          "pane_info",
        ).pane;
        if (target.agent)
          throw new Error(`Previous successor ${previous.paneId} is still occupied.`);
        const info = expectResult(
          await herdr.call(
            "pane.process_info",
            { pane_id: previous.paneId },
            { timeoutMs: 5000, signal },
          ),
          "pane_process_info",
        ).process_info;
        const observation = await observeForeground(info);
        if (observation.kind !== "idle")
          throw new Error(`Previous successor ${previous.paneId} has uncertain live ownership.`);
      } catch (error) {
        if (!(error instanceof HerdrRequestError && error.code === "pane_not_found")) throw error;
      }
    }
  };
  signal?.throwIfAborted();
  const claim = await claimCheckout(checkout.worktree.path, sourceSessionFile, signal, {
    id,
    assertAvailable,
  });
  if (!checkout.already_open) return { pane: checkout.root_pane, claim };
  try {
    const pane = expectResult(
      await herdr.call(
        "tab.create",
        {
          workspace_id: checkout.workspace.workspace_id,
          cwd: checkout.worktree.path,
          label: "Pi",
          focus: false,
        },
        { timeoutMs: 5000, signal },
      ),
      "tab_created",
    ).root_pane;
    return { pane, claim };
  } catch (error) {
    await releaseCheckout(claim);
    throw error;
  }
}

export function registerWorktreeHandoff(pi: ExtensionAPI, deps: WorktreeHandoffDeps): void {
  const { herdr, currentPaneTarget, resolveWorktreeParent } = deps;
  const observeForeground = deps.observeForeground ?? observePaneForeground;
  let pending: { handoff: HandoffRequest; toolCallId: string } | undefined;
  let continuing: Exclude<WorktreeState, { kind: "requested" | "stopped" }> | undefined;

  function request(params: EnterRequest, ctx: ExtensionContext): HandoffRequest {
    if (ctx.mode !== "tui") throw new Error("Worktree handoff requires the interactive TUI.");
    const blocked = handoffBlock(ctx.sessionManager, ctx.cwd);
    if (blocked) throw new Error(blocked);
    if (ctx.hasPendingMessages())
      throw new Error("Handle queued messages before moving this conversation.");
    if (!params.branch.trim()) throw new Error("A task branch is required.");
    const sourceSessionFile = ctx.sessionManager.getSessionFile();
    if (!sourceSessionFile)
      throw new Error("Worktree handoff cannot move an ephemeral session (--no-session).");
    if (!ctx.model) throw new Error("Select a model before moving this conversation.");
    const saved = SessionManager.open(sourceSessionFile);
    if (
      !saved.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user")
    )
      throw new Error("Send a message in this session before moving it.");
    return {
      id: randomUUID(),
      sourceSessionFile,
      sourceSessionId: ctx.sessionManager.getSessionId(),
      request: { ...params, branch: worktreeBranchFromArg(params.branch) },
    };
  }

  async function launch(handoff: HandoffRequest, ctx: ExtensionContext): Promise<void> {
    let phase: LaunchPhase = { kind: "preparing" };
    const signal = ctx.signal;
    try {
      signal?.throwIfAborted();
      if (ctx.hasPendingMessages())
        throw new Error("Queued input arrived. Handoff stopped without moving this session.");
      const currentPane = expectResult(
        await herdr.call("pane.get", { pane_id: currentPaneTarget }, { timeoutMs: 5000, signal }),
        "pane_info",
      ).pane;
      const parent = await resolveWorktreeParent(
        undefined,
        undefined,
        ctx.cwd,
        currentPane.workspace_id,
        signal,
      );
      const checkout = await ensureWorktree(herdr, {
        cwd: parent.cwd ?? ctx.cwd,
        checkoutCwd: parent.checkoutCwd,
        ...handoff.request,
        focus: false,
        signal,
      });
      const { pane, claim } = await handoffPane(
        herdr,
        checkout,
        currentPane.pane_id,
        handoff.sourceSessionFile,
        signal,
        handoff.id,
        observeForeground,
      );
      const destination: HandoffDestination = {
        path: checkout.worktree.path,
        workspaceId: checkout.workspace.workspace_id,
        paneId: pane.pane_id,
        claimPath: claim.path,
      };
      phase = { kind: "reserved", claim, destination };
      const state = { ...handoff, kind: "launching", destination } satisfies WorktreeState;
      pi.appendEntry<WorktreeState>(HANDOFF_ENTRY, state);
      if (!ctx.model) throw new Error("The selected model is no longer available.");
      const command = buildPiHandoffCommand({
        sessionFile: handoff.sourceSessionFile,
        sessionName: pi.getSessionName(),
        successorId: handoff.id,
        model: ctx.model,
        thinking: pi.getThinkingLevel(),
        resourceArgs: handoffResourceArgs(process.argv, ctx.cwd),
      });
      const deadline = Date.now() + 2000;
      while (true) {
        signal?.throwIfAborted();
        const target = expectResult(
          await herdr.call("pane.get", { pane_id: pane.pane_id }, { timeoutMs: 5000, signal }),
          "pane_info",
        ).pane;
        if (target.agent)
          throw new Error(
            `Destination pane ${pane.pane_id} is busy with an agent. No launch input was sent.`,
          );
        const info = expectResult(
          await herdr.call(
            "pane.process_info",
            { pane_id: pane.pane_id },
            { timeoutMs: 5000, signal },
          ),
          "pane_process_info",
        ).process_info;
        const observation = await observeForeground(info);
        if (observation.kind === "idle") break;
        if (observation.kind === "busy")
          throw new Error(
            `Destination pane ${pane.pane_id} is busy. ${observation.reason} No launch input was sent.`,
          );
        if (Date.now() >= deadline)
          throw new Error(
            `Destination pane ${pane.pane_id} did not initialize its shell. No launch input was sent.`,
          );
        await delay(100, undefined, { signal });
      }
      signal?.throwIfAborted();
      phase = { kind: "submitted", claim, destination };
      expectResult(
        await herdr.call(
          "pane.send_input",
          {
            pane_id: pane.pane_id,
            text: command,
            keys: ["Enter"],
          },
          { timeoutMs: 5000, signal },
        ),
        "ok",
      );
      await new HandoffReadiness(claim.path, handoff.id).wait(60_000, signal);
      pi.appendEntry<WorktreeState>(HANDOFF_ENTRY, { ...state, kind: "transferred" });
      try {
        await herdr.call("tab.focus", { tab_id: pane.tab_id }, { timeoutMs: 5000, signal });
      } catch (error) {
        ctx.ui.notify(`Successor ready, but focus failed: ${errorMessage(error)}`, "warning");
      }
      ctx.ui.notify(
        `Continuing in ${destination.path}. This Pi will exit; its tab is left intact.`,
        "info",
      );
      ctx.shutdown();
    } catch (error) {
      const reason = errorMessage(error);
      if (phase.kind === "reserved") {
        try {
          await releaseCheckout(phase.claim);
        } catch (releaseError) {
          ctx.ui.notify(
            `Could not release unused handoff reservation: ${errorMessage(releaseError)}`,
            "error",
          );
        }
      }
      if (phase.kind === "submitted") {
        const { destination } = phase;
        try {
          const decision = await new HandoffReadiness(destination.claimPath, handoff.id).decide(
            "stopped",
          );
          if (decision === "ready") {
            pi.appendEntry<WorktreeState>(HANDOFF_ENTRY, {
              ...handoff,
              kind: "transferred",
              destination,
            });
            ctx.ui.notify(
              `Successor already acknowledged readiness in ${destination.paneId}. Use that session.`,
              "warning",
            );
            return;
          }
        } catch (stopError) {
          ctx.ui.notify(
            `Could not cancel successor readiness: ${errorMessage(stopError)}`,
            "error",
          );
        }
      }
      pi.appendEntry<WorktreeState>(HANDOFF_ENTRY, {
        ...handoff,
        kind: "stopped",
        destination: phase.kind === "preparing" ? null : phase.destination,
        reason,
      });
      ctx.ui.notify(`Worktree handoff stopped: ${reason}`, "error");
    }
  }

  pi.registerTool({
    name: "worktree_enter",
    label: "Enter task worktree",
    description:
      "Move this dedicated task conversation into a plain Git worktree and continue there. Stops this source run after saving the tool result. Not for supporting checkouts or coordinating other work.",
    exposure: "model-only",
    executionMode: "sequential",
    promptSnippet: "Move a sole active task and its conversation into its own worktree.",
    promptGuidelines: [
      "Use worktree_enter when the user asks the sole active task in this conversation to live in a separate worktree, including after multi-turn discussion. Decide from the conversation's task relationship, never its age, message count, or keyword matching.",
      "If this chat coordinates other ongoing work, or the checkout is for verification, delegation, or supporting work, use herdr worktree_create/worktree_open instead. Those operations never move this session.",
      "Call worktree_enter alone, not alongside other tools. It saves this result before forking the transcript, continues the original user task in the target checkout, and stops work in the old cwd. Never take over an existing destination agent.",
    ],
    parameters: EnterParameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const current = worktreeState(ctx.sessionManager.getBranch());
      if (
        current?.kind === "owned" &&
        !handoffBlock(ctx.sessionManager, ctx.cwd) &&
        current.request.branch === worktreeBranchFromArg(params.branch)
      )
        return {
          content: [
            {
              type: "text",
              text: `This task already owns ${current.destination.path}. Continue here.`,
            },
          ],
          details: { handoffId: current.id },
        };
      const handoff = request(params, ctx);
      pi.appendEntry<WorktreeState>(HANDOFF_ENTRY, { ...handoff, kind: "requested" });
      pending = { handoff, toolCallId };
      return {
        content: [
          {
            type: "text",
            text: `Handoff requested for ${handoff.request.branch}. Continue the original task in the successor; do not work in the source checkout.`,
          },
        ],
        details: { handoffId: handoff.id },
        terminate: true,
      };
    },
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!pending) return;
    const { handoff, toolCallId } = pending;
    pending = undefined;
    const result = event.toolResults.find((result) => result.toolCallId === toolCallId);
    if (event.outcome !== "completed" || !result || result.isError) {
      pi.appendEntry<WorktreeState>(HANDOFF_ENTRY, {
        ...handoff,
        kind: "stopped",
        destination: null,
        reason: "The handoff tool did not complete.",
      });
      ctx.ui.notify(
        "Worktree handoff cancelled before launch. No successor was started.",
        "warning",
      );
      return;
    }
    try {
      const persisted = SessionManager.open(handoff.sourceSessionFile).getBranch();
      if (
        !persisted.some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolCallId === toolCallId &&
            event.toolResultEntryIds.includes(entry.id) &&
            !entry.message.isError,
        )
      )
        throw new Error("Refusing to fork before the handoff tool result is saved.");
      await launch(handoff, ctx);
    } catch (error) {
      pi.appendEntry<WorktreeState>(HANDOFF_ENTRY, {
        ...handoff,
        kind: "stopped",
        destination: null,
        reason: errorMessage(error),
      });
      ctx.ui.notify(`Worktree handoff stopped: ${errorMessage(error)}`, "error");
    } finally {
      ctx.abort();
    }
  });

  pi.on("tool_call", (_event, ctx) => {
    const assistant = ctx.sessionManager
      .getBranch()
      .slice()
      .reverse()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant");
    const calls =
      assistant?.type === "message" && assistant.message.role === "assistant"
        ? assistant.message.content.filter((part) => part.type === "toolCall")
        : [];
    if (calls.length > 1 && calls.some((call) => call.name === "worktree_enter"))
      return {
        block: true,
        reason: "Call worktree_enter alone in its own tool turn.",
        terminate: true,
      };
    const reason = handoffBlock(ctx.sessionManager, ctx.cwd);
    if (reason) return { block: true, reason, terminate: true };
  });
  pi.on("input", (_event, ctx) => {
    const reason = handoffBlock(ctx.sessionManager, ctx.cwd);
    if (reason) {
      ctx.ui.notify(reason, "warning");
      return { action: "handled" };
    }
  });
  async function interrupt(ctx: ExtensionContext, reason: string): Promise<void> {
    pending = undefined;
    continuing = undefined;
    const state = worktreeState(ctx.sessionManager.getBranch());
    if (
      state?.sourceSessionId !== ctx.sessionManager.getSessionId() ||
      (state.kind !== "requested" && state.kind !== "launching")
    )
      return;
    if (state.kind === "launching") {
      try {
        if (
          (await new HandoffReadiness(state.destination.claimPath, state.id).decide("stopped")) ===
          "ready"
        ) {
          pi.appendEntry<WorktreeState>(HANDOFF_ENTRY, { ...state, kind: "transferred" });
          return;
        }
      } catch (error) {
        ctx.ui.notify(`Could not cancel successor readiness: ${errorMessage(error)}`, "error");
      }
    }
    pi.appendEntry<WorktreeState>(HANDOFF_ENTRY, {
      ...state,
      kind: "stopped",
      destination: "destination" in state ? state.destination : null,
      reason,
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    await interrupt(ctx, "Source session reloaded or resumed before completion.");
    const state = worktreeState(ctx.sessionManager.getBranch());
    if (
      state?.kind === "launching" &&
      state.id === ctx.sessionManager.getSessionId() &&
      currentPaneTarget === state.destination.paneId &&
      (await realpath(ctx.cwd)) === state.destination.path
    )
      return;
    const reason = handoffBlock(ctx.sessionManager, ctx.cwd);
    if (reason) ctx.ui.notify(reason, "warning");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await interrupt(ctx, "Source session stopped before completion.");
  });

  pi.registerCommand("worktree", {
    description: "Create a plain worktree and continue this Pi conversation there",
    handler: async (args, ctx) => {
      try {
        if (!args.trim()) throw new Error("Usage: /worktree <branch>");
        if (!ctx.isIdle()) throw new Error("Finish or abort the current run before /worktree.");
        const current = worktreeState(ctx.sessionManager.getBranch());
        if (
          current?.kind === "owned" &&
          !handoffBlock(ctx.sessionManager, ctx.cwd) &&
          current.request.branch === worktreeBranchFromArg(args)
        ) {
          ctx.ui.notify(`This task already owns ${current.destination.path}.`, "info");
          return;
        }
        const handoff = request({ branch: args }, ctx);
        pi.appendEntry<WorktreeState>(HANDOFF_ENTRY, { ...handoff, kind: "requested" });
        await launch(handoff, ctx);
      } catch (error) {
        ctx.ui.notify(`Worktree handoff failed: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.registerCommand("worktree-continue", {
    description: "Accept a pending worktree handoff in its designated successor",
    handler: async (id, ctx) => {
      try {
        const state = worktreeState(ctx.sessionManager.getBranch());
        if (
          state?.kind !== "launching" ||
          state.id !== id.trim() ||
          state.id !== ctx.sessionManager.getSessionId()
        )
          throw new Error("No pending handoff for this successor. It will not be replayed.");
        if (
          (await realpath(ctx.cwd)) !== state.destination.path ||
          currentPaneTarget !== state.destination.paneId
        )
          throw new Error("This session is not in the designated handoff checkout and pane.");
        const source = worktreeState(SessionManager.open(state.sourceSessionFile).getBranch());
        if (source?.kind !== "launching" || source.id !== state.id)
          throw new Error("The source handoff is no longer launching. Inspect the source session.");
        pi.appendEntry<WorktreeState>(HANDOFF_ENTRY, { ...state, kind: "owned" });
        continuing = state;
        pi.sendUserMessage(
          `Continue the original user task from the forked conversation in ${state.destination.path} on ${state.request.branch}. The worktree handoff is complete. Resume the agreed next step, preserving the user's scope, approvals, and constraints. Do not create another handoff or repeat completed work.`,
          { deliverAs: "followUp" },
        );
      } catch (error) {
        ctx.ui.notify(`Worktree continuation refused: ${errorMessage(error)}`, "error");
      }
    },
  });

  pi.on("agent_start", async (_event, ctx) => {
    const state = continuing;
    if (!state) return;
    continuing = undefined;
    try {
      const source = worktreeState(SessionManager.open(state.sourceSessionFile).getBranch());
      if (source?.kind !== "launching" || source.id !== state.id)
        throw new Error("Source stopped before successor readiness.");
      const decision = await new HandoffReadiness(state.destination.claimPath, state.id).decide(
        "ready",
      );
      if (decision !== "ready") throw new Error("Source stopped before successor readiness.");
    } catch (error) {
      ctx.abort();
      pi.appendEntry<WorktreeState>(HANDOFF_ENTRY, {
        ...state,
        kind: "stopped",
        reason: errorMessage(error),
      });
      ctx.ui.notify(`Worktree continuation stopped: ${errorMessage(error)}`, "error");
    }
  });
}
