import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { statSync } from "node:fs";

import { expectResult, type HerdrClient } from "./client.ts";
import { ensureWorktree, type FlatWorkspace } from "./flat-worktree.ts";

// The successor Pi closes this tab once it is up. Carrying the tab id in the
// environment means the old tab only disappears after a working replacement
// has actually reached session_start.
const CLOSE_TAB_ENV = "PI_HERDR_CLOSE_TAB";
const PI_READY_TIMEOUT_MS = 60_000;
const PI_READY_POLL_MS = 500;

export interface WorktreeParentResolution {
  workspaceId: string | undefined;
  cwd: string | undefined;
  checkoutCwd?: string;
}

export interface WorktreeHandoffDeps {
  herdr: HerdrClient;
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

export function buildPiHandoffCommand(options: {
  sessionFile: string;
  sessionName: string | undefined;
  closeTabId: string;
}): string {
  // A fresh worktree's .envrc is not trusted yet, so Pi would start without the
  // repo environment. Allow and load it the same way the interactive shell does.
  const direnvPrelude =
    'if [ -f .envrc ] && command -v direnv >/dev/null 2>&1; then direnv allow . >/dev/null 2>&1; eval "$(direnv export bash 2>/dev/null)"; fi;';
  const parts = [
    direnvPrelude,
    `${CLOSE_TAB_ENV}=${shellQuote(options.closeTabId)}`,
    "pi",
    "--fork",
    shellQuote(options.sessionFile),
  ];
  const sessionName = options.sessionName?.trim();
  if (sessionName) parts.push("--name", shellQuote(sessionName));
  return parts.join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasSavedTranscript(sessionFile: string): boolean {
  try {
    return statSync(sessionFile).size > 0;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPiAgent(
  herdr: HerdrClient,
  paneId: string,
  timeoutMs = PI_READY_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pane = expectResult(
        await herdr.call("pane.get", { pane_id: paneId }, { timeoutMs: 5000 }),
        "pane_info",
      ).pane;
      if (pane.agent === "pi") return true;
    } catch {
      // The pane may not be queryable yet while its shell initializes.
    }
    await sleep(PI_READY_POLL_MS);
  }
  return false;
}

export function registerWorktreeHandoff(pi: ExtensionAPI, deps: WorktreeHandoffDeps): void {
  const { herdr, currentPaneTarget, resolveWorktreeParent } = deps;

  pi.on("session_start", async (_event, _ctx) => {
    const closeTabId = process.env[CLOSE_TAB_ENV];
    if (!closeTabId) return;
    delete process.env[CLOSE_TAB_ENV];
    try {
      await herdr.call("tab.close", { tab_id: closeTabId }, { timeoutMs: 5000 });
    } catch {
      // The source tab may already be gone; closing it is best-effort cleanup.
    }
  });

  pi.registerCommand("worktree", {
    description: "Create a flat Git worktree workspace and move this Pi session into it",
    handler: async (args, ctx) => {
      await runWorktreeHandoff(args, pi.getSessionName(), ctx, deps);
    },
  });
}

export async function handoffPane(
  herdr: Pick<HerdrClient, "call">,
  checkout: FlatWorkspace,
  sourcePaneId: string,
): Promise<FlatWorkspace["root_pane"]> {
  if (!checkout.already_open) return checkout.root_pane;
  const panes = expectResult(
    await herdr.call("pane.list", { workspace_id: checkout.workspace.workspace_id }),
    "pane_list",
  ).panes;
  if (panes.some((pane) => pane.pane_id === sourcePaneId || pane.agent))
    throw new Error(
      "The target workspace already has an agent. Use that session or choose another branch.",
    );
  return expectResult(
    await herdr.call("tab.create", {
      workspace_id: checkout.workspace.workspace_id,
      cwd: checkout.worktree.path,
      label: "Pi",
      focus: false,
    }),
    "tab_created",
  ).root_pane;
}

async function runWorktreeHandoff(
  args: string,
  sessionName: string | undefined,
  ctx: ExtensionCommandContext,
  deps: WorktreeHandoffDeps,
): Promise<void> {
  const { herdr, currentPaneTarget, resolveWorktreeParent } = deps;
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/worktree is only available in the interactive TUI.", "error");
    return;
  }
  const branchArg = args.trim();
  if (!branchArg) {
    ctx.ui.notify("Usage: /worktree <branch>", "error");
    return;
  }
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    ctx.ui.notify("/worktree cannot move an ephemeral session (--no-session).", "error");
    return;
  }
  if (!hasSavedTranscript(sessionFile)) {
    ctx.ui.notify(
      "/worktree needs a saved transcript; send a message in this session first.",
      "error",
    );
    return;
  }
  const branch = worktreeBranchFromArg(branchArg);

  try {
    await ctx.waitForIdle();
    const currentPane = expectResult(
      await herdr.call("pane.get", { pane_id: currentPaneTarget }, { timeoutMs: 5000 }),
      "pane_info",
    ).pane;
    const parent = await resolveWorktreeParent(
      undefined,
      undefined,
      ctx.cwd,
      currentPane.workspace_id,
    );
    const created = await ensureWorktree(herdr, {
      cwd: parent.checkoutCwd ?? parent.cwd ?? ctx.cwd,
      branch,
      label: branch,
      focus: false,
    });
    const rootPaneId = (await handoffPane(herdr, created, currentPane.pane_id)).pane_id;

    try {
      await herdr.call(
        "workspace.focus",
        { workspace_id: created.workspace.workspace_id },
        { timeoutMs: 5000 },
      );
    } catch {
      // Focus is a convenience; the handoff still works without it.
    }

    const command = buildPiHandoffCommand({
      sessionFile,
      sessionName,
      closeTabId: currentPane.tab_id,
    });
    // TODO(agent-start): prefer herdr's `agent.start` here. It names the agent and
    // returns only once it is ready, but it rejects panes inside the netns wrapper
    // with `agent_pane_busy` ("not an available shell") because the wrapper is the
    // foreground process. Revisit once herdr's shell-availability check understands
    // that wrapper; until then we type the launch line and poll for the agent.
    expectResult(
      await herdr.call(
        "pane.send_input",
        { pane_id: rootPaneId, text: command, keys: ["Enter"] },
        { timeoutMs: 5000 },
      ),
      "ok",
    );

    if (!(await waitForPiAgent(herdr, rootPaneId))) {
      ctx.ui.notify(
        `Worktree ${branch} created, but Pi did not start in pane ${rootPaneId}. Check that pane.`,
        "error",
      );
      return;
    }
    ctx.ui.notify(`Moving this session to ${branch}; the old tab will close.`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`/worktree failed: ${message}`, "error");
  }
}
