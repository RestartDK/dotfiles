import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { expectResult, HerdrClient } from "./client.ts";
import type {
  AgentStatus,
  PaneInfo,
  PaneProcessInfo,
  TabInfo,
  WorkspaceInfo,
  WorktreeInfo,
} from "./generated/success-response.ts";

type ToolReadSource = "visible" | "recent" | "recent-unwrapped";

const DEFAULT_COMPLETION_TIMEOUT_MS = 600_000;
const NOTIFIER_MAX_ELAPSED_MS = 6 * 60 * 60 * 1000;
const SHELL_PROCESS_PATTERN = /^(zsh|bash|fish|sh|starship)$/;

interface ManagedPane {
  paneId: string;
  workspaceId: string;
}

interface PendingRun {
  paneId: string;
  paneLabel: string;
  runId: string;
  command: string;
  marker: string | null;
  startedAt: number;
  abort: AbortController;
}

type Completion =
  | { kind: "running"; foreground: string | null; elapsedMs: number }
  | { kind: "done"; exitCode: number | null; elapsedMs: number; tail: string };

interface HerdrToolDetails {
  action?: string;
  aliases: Record<string, ManagedPane>;
  aliasOrder: string[];
  [key: string]: unknown;
}

const ActionEnum = StringEnum(
  [
    "list",
    "workspace_list",
    "workspace_create",
    "workspace_focus",
    "worktree_list",
    "worktree_create",
    "worktree_open",
    "worktree_remove",
    "tab_list",
    "tab_create",
    "tab_focus",
    "tab_close",
    "focus",
    "pane_split",
    "run",
    "read",
    "watch",
    "wait",
    "wait_agent",
    "send",
    "stop",
  ] as const,
  { description: "Action to perform" },
);

const StatusEnum = StringEnum(["idle", "working", "blocked", "done", "unknown"] as const, {
  description: "Agent status to wait for",
});

const SourceEnum = StringEnum(["visible", "recent", "recent-unwrapped"] as const, {
  description: "Read source for read/watch",
});

const DirectionEnum = StringEnum(["right", "down"] as const, {
  description: "Split direction for pane_split. Defaults to right.",
});

const WaitModeEnum = StringEnum(["all", "any"] as const, {
  description: "How multi-pane waits should resolve",
});

export default function (pi: ExtensionAPI) {
  const herdrEnv = process.env.HERDR_ENV;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const currentPaneTargetEnv = process.env.HERDR_PANE_ID;
  if (herdrEnv !== "1" || !socketPath || !currentPaneTargetEnv) {
    return;
  }
  const currentPaneTarget = currentPaneTargetEnv;
  const herdr = new HerdrClient(socketPath);
  const lifecycleSource = `pi-herdr:${process.pid}:${Date.now()}`;
  let lifecycleSeq = 0;
  let lifecycleErrorLogged = false;

  const managedPanes = new Map<string, ManagedPane>();
  const aliasOrder: string[] = [];
  const pendingRuns = new Map<string, PendingRun>();
  const notifyingRunIds = new Set<string>();
  const lastCommandByPane = new Map<string, string>();

  function snapshotAliases(): Record<string, ManagedPane> {
    return Object.fromEntries(managedPanes.entries());
  }

  function withSnapshot(
    details: Omit<HerdrToolDetails, "aliases" | "aliasOrder">,
  ): HerdrToolDetails {
    return {
      ...details,
      aliases: snapshotAliases(),
      aliasOrder: [...aliasOrder],
    };
  }

  function setAliases(aliases: Record<string, ManagedPane>, order: string[]) {
    managedPanes.clear();
    aliasOrder.length = 0;
    for (const [alias, managed] of Object.entries(aliases)) {
      managedPanes.set(alias, managed);
    }
    for (const alias of order) {
      if (managedPanes.has(alias)) aliasOrder.push(alias);
    }
    for (const alias of managedPanes.keys()) {
      if (!aliasOrder.includes(alias)) aliasOrder.push(alias);
    }
  }

  function reconstructState(ctx: ExtensionContext) {
    let aliases: Record<string, ManagedPane> = {};
    let order: string[] = [];

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "toolResult" || message.toolName !== "herdr") continue;
      const details = message.details as HerdrToolDetails | undefined;
      if (!details?.aliases) continue;
      aliases = details.aliases;
      order = Array.isArray(details.aliasOrder) ? details.aliasOrder : Object.keys(details.aliases);
    }

    setAliases(aliases, order);
  }

  function logLifecycleError(action: string, error: unknown) {
    if (lifecycleErrorLogged) return;
    lifecycleErrorLogged = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pi-herdr] Failed to ${action}: ${message}`);
  }

  async function reportAgentState(state: "idle" | "working", ctx: ExtensionContext) {
    try {
      expectResult(
        await herdr.call(
          "pane.report_agent",
          {
            agent: "pi",
            agent_session_id: ctx.sessionManager.getSessionId(),
            agent_session_path: ctx.sessionManager.getSessionFile() ?? null,
            pane_id: currentPaneTarget,
            seq: ++lifecycleSeq,
            source: lifecycleSource,
            state,
          },
          { timeoutMs: 2000 },
        ),
        "ok",
      );
      lifecycleErrorLogged = false;
    } catch (error) {
      logLifecycleError(`report Pi as ${state}`, error);
    }
  }

  async function releaseAgent() {
    try {
      expectResult(
        await herdr.call(
          "pane.release_agent",
          {
            agent: "pi",
            pane_id: currentPaneTarget,
            seq: ++lifecycleSeq,
            source: lifecycleSource,
          },
          { timeoutMs: 2000 },
        ),
        "ok",
      );
    } catch (error) {
      logLifecycleError("release Pi agent state", error);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    reconstructState(ctx);
    await reportAgentState("idle", ctx);
  });
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
  pi.on("agent_start", async (_event, ctx) => reportAgentState("working", ctx));
  pi.on("agent_settled", async (_event, ctx) =>
    reportAgentState(ctx.isIdle() ? "idle" : "working", ctx),
  );
  pi.on("session_shutdown", async () => {
    for (const pendingRun of pendingRuns.values()) pendingRun.abort.abort();
    pendingRuns.clear();
    notifyingRunIds.clear();
    await releaseAgent();
  });

  function recordAlias(alias: string, paneId: string, workspaceId: string) {
    managedPanes.set(alias, { paneId, workspaceId });
    const existingIndex = aliasOrder.indexOf(alias);
    if (existingIndex !== -1) aliasOrder.splice(existingIndex, 1);
    aliasOrder.push(alias);
  }

  function forgetAlias(alias: string) {
    managedPanes.delete(alias);
    const index = aliasOrder.indexOf(alias);
    if (index !== -1) aliasOrder.splice(index, 1);
  }

  function isAbortError(error: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted === true || (error instanceof Error && error.message === "Aborted");
  }

  async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Aborted");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timeout);
        reject(new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function absolutePath(value: string | undefined, cwd: string): string | undefined {
    if (!value) return undefined;
    if (value === "~") return homedir();
    if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
    return resolve(cwd, value);
  }

  function protocolReadSource(
    source: ToolReadSource | undefined,
    lines?: number,
  ): "visible" | "recent" | "recent_unwrapped" {
    // herdr's recent sources slice `lines` from scrolled-off text only, so a pane whose output is
    // still on screen reads back empty; visible carries the same tail when a line count is given.
    if (lines != null) return "visible";
    return source === "recent-unwrapped" ? "recent_unwrapped" : (source ?? "recent");
  }

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }

  function selectedPiNetns(): string | null {
    const value = process.env.PI_NETNS_SELECTED?.trim();
    return value ? value : null;
  }

  function piRunDevNetns(): string {
    const value = process.env.PI_NETNS_RUN_DEV_NETNS?.trim();
    return value || "/run/current-system/sw/bin/run-dev-netns";
  }

  function buildEnterPiNetnsCommand(namespace: string): string {
    const runDevNetns = piRunDevNetns();
    return [
      `export PI_NETNS=${shellQuote(namespace)}`,
      `export PI_NETNS_SELECTED=${shellQuote(namespace)}`,
      `export PI_NETNS_RUN_DEV_NETNS=${shellQuote(runDevNetns)}`,
      `exec /run/wrappers/bin/sudo -n -E ${shellQuote(runDevNetns)} ${shellQuote(namespace)} "\${SHELL:-/bin/sh}" -l`,
    ].join("; ");
  }

  async function enterPiNetnsInPane(paneId: string, signal?: AbortSignal): Promise<string | null> {
    const namespace = selectedPiNetns();
    if (!namespace) return null;
    expectResult(
      await herdr.call(
        "pane.send_input",
        { pane_id: paneId, text: buildEnterPiNetnsCommand(namespace), keys: ["Enter"] },
        { signal },
      ),
      "ok",
    );
    await sleep(800, signal);
    return namespace;
  }

  async function getCurrentPaneInfo(signal?: AbortSignal): Promise<PaneInfo> {
    return expectResult(
      await herdr.call("pane.get", { pane_id: currentPaneTarget }, { signal }),
      "pane_info",
    ).pane;
  }

  async function getWorkspaceList(signal?: AbortSignal): Promise<WorkspaceInfo[]> {
    return expectResult(await herdr.call("workspace.list", {}, { signal }), "workspace_list")
      .workspaces;
  }

  async function getWorkspacePanes(workspaceId: string, signal?: AbortSignal): Promise<PaneInfo[]> {
    return expectResult(
      await herdr.call("pane.list", { workspace_id: workspaceId }, { signal }),
      "pane_list",
    ).panes;
  }

  async function getTabList(workspaceId?: string, signal?: AbortSignal): Promise<TabInfo[]> {
    return expectResult(
      await herdr.call("tab.list", { workspace_id: workspaceId }, { signal }),
      "tab_list",
    ).tabs;
  }

  async function getPaneInfo(paneId: string, signal?: AbortSignal): Promise<PaneInfo | null> {
    try {
      return expectResult(
        await herdr.call("pane.get", { pane_id: paneId }, { signal }),
        "pane_info",
      ).pane;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      return null;
    }
  }

  async function resolveManagedPane(
    alias: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<ManagedPane | null> {
    const managed = managedPanes.get(alias);
    if (!managed) return null;
    if (managed.workspaceId !== workspaceId) return null;

    const pane = await getPaneInfo(managed.paneId, signal);
    if (!pane) {
      forgetAlias(alias);
      return null;
    }

    return managed;
  }

  async function resolvePaneRef(
    ref: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<{ pane: PaneInfo; alias?: string } | null> {
    const managed = await resolveManagedPane(ref, workspaceId, signal);
    if (managed) {
      const pane = await getPaneInfo(managed.paneId, signal);
      if (!pane) {
        forgetAlias(ref);
        return null;
      }
      return { pane, alias: ref };
    }

    const pane = await getPaneInfo(ref, signal);
    if (!pane || pane.workspace_id !== workspaceId) return null;
    const alias = [...managedPanes.entries()].find(
      ([, managedPane]) => managedPane.paneId === pane.pane_id,
    )?.[0];
    return { pane, alias };
  }

  async function requirePaneRef(
    ref: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<{ pane: PaneInfo; alias?: string }> {
    const hadAlias = managedPanes.has(ref);
    const resolved = await resolvePaneRef(ref, workspaceId, signal);
    if (resolved) return resolved;
    if (hadAlias) {
      throw new Error(`Pane alias '${ref}' no longer points to a live pane and was removed.`);
    }
    throw new Error(`Pane '${ref}' not found in the current workspace.`);
  }

  async function readPane(
    paneId: string,
    options: { source?: ToolReadSource; lines?: number; raw?: boolean },
    signal?: AbortSignal,
  ): Promise<string> {
    const result = expectResult(
      await herdr.call(
        "pane.read",
        {
          pane_id: paneId,
          source: protocolReadSource(options.source, options.lines),
          lines: options.lines,
          format: options.raw ? "ansi" : "text",
          strip_ansi: options.raw !== true,
        },
        { signal },
      ),
      "pane_read",
    );
    return result.read.text;
  }

  function formatReadOutput(output: string): string {
    const truncation = truncateTail(output, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    let text = truncation.content;
    if (truncation.truncated) {
      text = `[Showing last ${truncation.outputLines} of ${truncation.totalLines} lines]\n${text}`;
    }
    return text;
  }

  function abortPendingRun(paneId: string) {
    const pendingRun = pendingRuns.get(paneId);
    if (!pendingRun) return;
    pendingRun.abort.abort();
    pendingRuns.delete(paneId);
  }

  function completionPollInterval(elapsedMs: number): number {
    if (elapsedMs < 30_000) return 1_000;
    if (elapsedMs < 10 * 60_000) return 3_000;
    return 5_000;
  }

  function formatElapsed(elapsedMs: number): string {
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = String(elapsedSeconds % 60).padStart(2, "0");
    return `${minutes}m ${seconds}s`;
  }

  function parseExitCode(output: string, marker: string | null): number | null {
    if (!marker) return null;
    const matches = output.matchAll(new RegExp(`^${marker}=(\\d+)\\s*$`, "gm"));
    let exitCode: number | null = null;
    for (const match of matches) exitCode = Number(match[1]);
    return exitCode;
  }

  async function readForeground(
    paneId: string,
    signal?: AbortSignal,
  ): Promise<{ done: boolean; foreground: string | null }> {
    const processInfo: PaneProcessInfo = expectResult(
      await herdr.call("pane.process_info", { pane_id: paneId }, { signal, timeoutMs: 5_000 }),
      "pane_process_info",
    ).process_info;
    const names = (processInfo.foreground_processes ?? []).map((process) => process.name);
    const shellPid = processInfo.shell_pid;
    const done =
      (shellPid != null && processInfo.foreground_process_group_id === shellPid) ||
      (shellPid == null && names.every((name) => SHELL_PROCESS_PATTERN.test(name)));
    return { done, foreground: names.length ? names.join(",") : null };
  }

  async function probe(
    pendingRun: PendingRun,
    lines: number,
    signal?: AbortSignal,
  ): Promise<Completion> {
    const { done: shellIdle, foreground } = await readForeground(pendingRun.paneId, signal);
    const elapsedMs = Date.now() - pendingRun.startedAt;
    if (!shellIdle) return { kind: "running", foreground, elapsedMs };

    const output = await readPane(
      pendingRun.paneId,
      { source: "visible", lines, raw: false },
      signal,
    );
    const exitCode = parseExitCode(output, pendingRun.marker);
    if (pendingRun.marker && exitCode == null) {
      return {
        kind: "running",
        foreground: `${foreground ?? "unknown"}; exit marker not printed yet`,
        elapsedMs,
      };
    }
    return {
      kind: "done",
      exitCode,
      elapsedMs,
      tail: formatReadOutput(stripMarkerLines(output)),
    };
  }

  function stripMarkerLines(output: string): string {
    return output
      .split("\n")
      .filter((line) => !/^__pi_rc_[0-9a-f]{6}=\d+\s*$/.test(line))
      .join("\n");
  }

  async function waitForCompletion(
    pendingRun: PendingRun,
    lines: number,
    timeoutMs: number,
    initialDelayMs: number,
    signal?: AbortSignal,
  ): Promise<Completion> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    if (initialDelayMs > 0) {
      await sleep(Math.min(initialDelayMs, Math.max(0, deadline - Date.now())), signal);
    }

    while (true) {
      const completion = await probe(pendingRun, lines, signal);
      if (completion.kind === "done") return completion;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return completion;
      await sleep(Math.min(completionPollInterval(completion.elapsedMs), remainingMs), signal);
    }
  }

  function isPaneGoneError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /(?:pane.*(?:not found|does not exist|no longer exists|closed))|(?:(?:not found|does not exist).*pane)/i.test(
      message,
    );
  }

  function sendNotifierMessage(content: string, details: Record<string, unknown>) {
    try {
      pi.sendMessage(
        { customType: "herdr-run-finished", content, display: true, details },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch (error) {
      logLifecycleError("deliver a command completion notification", error);
    }
  }

  function startNotifier(pendingRun: PendingRun, lines: number, initialDelayMs: number) {
    if (
      notifyingRunIds.has(pendingRun.runId) ||
      pendingRuns.get(pendingRun.paneId) !== pendingRun
    ) {
      return;
    }
    notifyingRunIds.add(pendingRun.runId);

    void (async () => {
      const signal = pendingRun.abort.signal;
      try {
        if (initialDelayMs > 0) await sleep(initialDelayMs, signal);

        while (!signal.aborted && pendingRuns.get(pendingRun.paneId) === pendingRun) {
          let completion: Completion;
          try {
            completion = await probe(pendingRun, lines, signal);
          } catch (error) {
            if (isAbortError(error, signal)) return;
            if (isPaneGoneError(error)) {
              sendNotifierMessage(
                `herdr: pane '${pendingRun.paneLabel}' closed before '${pendingRun.command}' finished`,
                { paneId: pendingRun.paneId, runId: pendingRun.runId },
              );
              if (pendingRuns.get(pendingRun.paneId) === pendingRun) {
                pendingRuns.delete(pendingRun.paneId);
              }
              return;
            }
            logLifecycleError("probe command completion", error);
            const elapsedMs = Date.now() - pendingRun.startedAt;
            if (elapsedMs >= NOTIFIER_MAX_ELAPSED_MS) {
              sendNotifierMessage(
                `herdr: '${pendingRun.command}' in pane '${pendingRun.paneLabel}' still running after 6h; stopped watching`,
                { paneId: pendingRun.paneId, runId: pendingRun.runId, elapsedMs },
              );
              if (pendingRuns.get(pendingRun.paneId) === pendingRun) {
                pendingRuns.delete(pendingRun.paneId);
              }
              return;
            }
            await sleep(
              Math.min(completionPollInterval(elapsedMs), NOTIFIER_MAX_ELAPSED_MS - elapsedMs),
              signal,
            );
            continue;
          }

          if (completion.kind === "done") {
            const exitCode = completion.exitCode == null ? "unknown" : completion.exitCode;
            const tail = completion.tail.split("\n").slice(-40).join("\n");
            sendNotifierMessage(
              `herdr: '${pendingRun.command}' in pane '${pendingRun.paneLabel}' finished: exit ${exitCode} after ${formatElapsed(completion.elapsedMs)}\n\n${tail}`,
              {
                paneId: pendingRun.paneId,
                runId: pendingRun.runId,
                exitCode: completion.exitCode,
                elapsedMs: completion.elapsedMs,
              },
            );
            if (pendingRuns.get(pendingRun.paneId) === pendingRun) {
              pendingRuns.delete(pendingRun.paneId);
            }
            return;
          }

          if (completion.elapsedMs >= NOTIFIER_MAX_ELAPSED_MS) {
            sendNotifierMessage(
              `herdr: '${pendingRun.command}' in pane '${pendingRun.paneLabel}' still running after 6h; stopped watching`,
              {
                paneId: pendingRun.paneId,
                runId: pendingRun.runId,
                elapsedMs: completion.elapsedMs,
              },
            );
            if (pendingRuns.get(pendingRun.paneId) === pendingRun) {
              pendingRuns.delete(pendingRun.paneId);
            }
            return;
          }

          await sleep(
            Math.min(
              completionPollInterval(completion.elapsedMs),
              NOTIFIER_MAX_ELAPSED_MS - completion.elapsedMs,
            ),
            signal,
          );
        }
      } catch (error) {
        if (!isAbortError(error, signal)) {
          logLifecycleError("watch command completion", error);
        }
      } finally {
        notifyingRunIds.delete(pendingRun.runId);
      }
    })();
  }

  function doneResult(
    action: "run" | "wait",
    pendingRun: PendingRun,
    completion: Extract<Completion, { kind: "done" }>,
    untracked: boolean,
  ) {
    const exitCode = completion.exitCode == null ? "unknown" : completion.exitCode;
    const untrackedText = untracked
      ? "\n\nno exit code: the command was not started with run wait/notify"
      : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `Finished '${pendingRun.command}' in pane '${pendingRun.paneLabel}' (${pendingRun.paneId}): exit ${exitCode} after ${formatElapsed(completion.elapsedMs)}${untrackedText}\n\n${completion.tail}`,
        },
      ],
      details: withSnapshot({
        action,
        pane: pendingRun.paneLabel,
        paneId: pendingRun.paneId,
        command: pendingRun.command,
        exitCode: completion.exitCode,
        elapsedMs: completion.elapsedMs,
        state: "done",
      }),
    };
  }

  function runningResult(
    action: "run" | "wait",
    pendingRun: PendingRun,
    completion: Extract<Completion, { kind: "running" }>,
    untracked: boolean,
    notifierStarted: boolean,
  ) {
    const foreground = completion.foreground ?? "unknown";
    const notifierText = notifierStarted
      ? " A notifier is active and will deliver a message when the command exits."
      : "";
    const untrackedText = untracked
      ? "\n\nno exit code: the command was not started with run wait/notify"
      : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `STILL RUNNING after ${formatElapsed(completion.elapsedMs)} in pane '${pendingRun.paneLabel}' (${pendingRun.paneId}): foreground ${foreground}. This is a status, not an error. Call wait again with a longer timeout, or wait with notify: true to get a message when it exits.${notifierText}${untrackedText}`,
        },
      ],
      details: withSnapshot({
        action,
        pane: pendingRun.paneLabel,
        paneId: pendingRun.paneId,
        command: pendingRun.command,
        exitCode: null,
        elapsedMs: completion.elapsedMs,
        state: "running",
        foreground: completion.foreground,
      }),
    };
  }

  function summarizePane(pane: PaneInfo, alias?: string, currentPaneId?: string): string {
    const name = alias || pane.pane_id;
    const flags = [
      pane.pane_id === currentPaneId || pane.focused ? "current" : null,
      pane.agent ? pane.agent : null,
      pane.agent_status !== "unknown" ? pane.agent_status : null,
    ]
      .filter(Boolean)
      .join(", ");
    const cwd = pane.cwd ? ` ${pane.cwd}` : "";
    return `${name}: [${pane.pane_id}]${flags ? ` (${flags})` : ""}${cwd}`;
  }

  function summarizeTab(tab: TabInfo): string {
    const flags = [
      tab.focused ? "focused" : null,
      tab.agent_status !== "unknown" ? tab.agent_status : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `${tab.label}: [${tab.tab_id}]${flags ? ` (${flags})` : ""}`;
  }

  function summarizeWorkspace(workspace: WorkspaceInfo): string {
    const flags = [
      workspace.focused ? "focused" : null,
      workspace.agent_status !== "unknown" ? workspace.agent_status : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `${workspace.label}: [${workspace.workspace_id}]${flags ? ` (${flags})` : ""}`;
  }

  function summarizeWorktree(worktree: WorktreeInfo): string {
    const name =
      worktree.branch || (worktree.is_detached ? "detached" : worktree.label || "worktree");
    const flags = [
      worktree.open_workspace_id ? `workspace ${worktree.open_workspace_id}` : null,
      worktree.is_linked_worktree ? "linked" : null,
      worktree.is_detached ? "detached" : null,
      worktree.is_prunable ? "prunable" : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `${name}: ${worktree.path}${flags ? ` (${flags})` : ""}`;
  }

  function rejectUnexpectedParams(
    action: string,
    params: { workspace?: string; tab?: string },
    unexpected: Array<"workspace" | "tab">,
  ) {
    const present = unexpected.filter((key) => params[key] != null);
    if (!present.length) return;
    throw new Error(
      `${action} targets panes, not ${present.join(" or ")}. Use a pane alias or pane id from list, or the root pane returned by tab_create/workspace_create.`,
    );
  }

  function formatStatusList(statuses: AgentStatus[]): string {
    return statuses.join("|");
  }

  function throwIfAborted(signal: AbortSignal | undefined, action: string) {
    if (signal?.aborted) {
      throw new Error(`${action} canceled.`);
    }
  }

  function statusDot(theme: any, status: AgentStatus): string {
    switch (status) {
      case "blocked":
        return theme.fg("warning", "●");
      case "working":
        return theme.fg("accent", "●");
      case "done":
        return theme.fg("success", "●");
      case "idle":
        return theme.fg("muted", "○");
      default:
        return theme.fg("dim", "·");
    }
  }

  pi.registerTool({
    name: "herdr",
    label: "herdr",
    description:
      "Herdr-native pane and dedicated-tab orchestration for long-running workflows. " +
      "Actions: list panes, manage workspaces, Git worktrees, and tabs, split panes in dedicated work tabs, submit lines atomically, detect command completion with exit codes and output tails, watch readiness, wait for one or more agent panes to reach target statuses, send raw text or keys, focus contexts, and stop panes.",
    promptGuidelines: [
      "Use `herdr` run for long-running processes in other panes instead of `bash`.",
      "Keep the tab containing Pi dedicated to the interactive Pi session. For tests, builds, servers, watchers, or other background work in the current project, first use `tab_create` with a descriptive label and a friendly `pane` alias for its root pane, then run work there.",
      "Group related processes in one dedicated work tab. If that workflow needs more panes, use `pane_split` on the root pane alias or another pane in that work tab; never split a pane in Pi's own tab.",
      "Remember every transient work tab and process you create. Before finishing the task, terminate processes you started and use `tab_close` to tear down their dedicated tabs, unless the user explicitly asked to leave a service or agent running.",
      "Use a new workspace instead of a tab when the work needs a separate Git worktree or broader isolation.",
      "When you want to submit a line or prompt to a pane, prefer `run` over `send` + `Enter` so text and Enter happen atomically.",
      "Use `send` only for low-level literal text or key injection when you do not want command-style submission semantics.",
      "Preserve the current UI focus by default. Create work tabs and panes with focus disabled unless the user explicitly asks to view them or the workflow truly requires visible interaction there.",
      "Pane actions like run, read, watch, wait, wait_agent, send, and stop must target pane aliases or pane ids, not tab ids. `pane_split` requires a source pane in a dedicated work tab.",
      "Use `herdr` workspace, worktree, tab, and pane_split actions to organize parallel work instead of piling everything into one pane stack.",
      "Use `worktree_create` to create a Git worktree checkout and open it as a Herdr workspace.",
      "Use `worktree_remove` to delete a Herdr-managed worktree checkout; it runs git worktree remove and does not delete the branch.",
      "For any command that finishes (tests, builds, clippy, scripts, CI suites), use `run` with `wait: true` (blocks up to `timeout`, default 10 minutes, returns exit code and tail) or `notify: true` (returns at once; a message arrives when it exits). Never poll with bash `sleep`. Never re-arm a timed-out watch.",
      "`watch` is for readiness patterns only, such as a server's listen line. Do not watch for sentinel echoes like `CI_EXIT=`; the shell echoes your command line and the match fires before the command runs.",
      "A `wait` result of STILL RUNNING is a status, not an error: call `wait` with `notify: true`, do other work, and act when the finished message arrives.",
      "Use `herdr` wait_agent only for panes running a recognized coding agent. It waits on agent statuses, not normal process completion; use run with wait/notify or the wait action for commands like tests or servers.",
      "Start every command you will wait on with `run` plus `wait` or `notify`. A bare `wait` on a pane whose command was started without them can only see process state, and panes inside the netns wrapper show only the wrapper, so it may report done early with exit code unknown.",
      "For agent panes, background finished panes usually become `done` while focused finished panes usually become `idle`.",
      "Use `recent-unwrapped` when you need log matching or reads that ignore soft wrapping. Giving `lines` switches any read or watch to the visible screen, because herdr's recent sources exclude text that has not scrolled off yet.",
      "Pane references can be either friendly aliases you created earlier or real herdr pane ids from `list`.",
      "Use `tab_create` with `pane` set to a friendly root-pane alias as the default way to establish a target for current-project background work. `pane_split` requires an existing pane alias/id outside Pi's tab and defaults its direction to right. `run` only works with an existing pane alias or pane id.",
      "When PI_NETNS_SELECTED is set, newly split panes automatically enter that network namespace before later commands are run in them.",
      "Use friendly pane aliases like `server`, `reviewer`, or `tests` so later reads, watches, sends, and cleanup can reuse them across the session.",
      "When starting a fresh pi instance in another pane and the model matters, either specify `--model` explicitly or ask the user which model/provider they want.",
    ],
    parameters: Type.Object({
      action: ActionEnum,
      pane: Type.Optional(
        Type.String({
          description:
            "Friendly pane alias or explicit pane id. For tab/workspace/worktree creation, an alias to assign to the new root pane. For pane_split, a required source pane outside Pi's tab.",
        }),
      ),
      panes: Type.Optional(
        Type.Array(Type.String(), { description: "Pane aliases or pane ids for multi-pane waits" }),
      ),
      workspace: Type.Optional(
        Type.String({ description: "Workspace id for workspace, worktree, or tab actions" }),
      ),
      tab: Type.Optional(
        Type.String({
          description:
            "Tab id for tab actions or focus(tab) only. Pane actions must use pane ids or aliases.",
        }),
      ),
      label: Type.Optional(
        Type.String({ description: "Workspace, worktree, or tab label for create/open actions" }),
      ),
      branch: Type.Optional(
        Type.String({ description: "Git branch name for worktree_create or worktree_open" }),
      ),
      base: Type.Optional(Type.String({ description: "Base ref for worktree_create" })),
      path: Type.Optional(
        Type.String({ description: "Filesystem path for worktree_create or worktree_open" }),
      ),
      newPane: Type.Optional(
        Type.String({ description: "Alias to remember for the pane created by pane_split" }),
      ),
      direction: Type.Optional(DirectionEnum),
      command: Type.Optional(
        Type.String({ description: "Line to submit atomically with Enter (for run action)" }),
      ),
      match: Type.Optional(
        Type.String({ description: "Text or regex to wait for (for watch action)" }),
      ),
      regex: Type.Optional(
        Type.Boolean({ description: "Treat match as a regex (for watch action)" }),
      ),
      status: Type.Optional(StatusEnum),
      statuses: Type.Optional(
        Type.Array(StatusEnum, { description: "Accepted agent statuses for wait_agent" }),
      ),
      mode: Type.Optional(WaitModeEnum),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Timeout in ms for run/wait completion, watch, or wait_agent. Run/wait defaults to 600000 ms.",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "For run or wait: block until the command in the pane exits, then return exit code and output tail. Timeout via `timeout` (default 600000 ms). A timeout returns a STILL RUNNING status, not an error.",
        }),
      ),
      notify: Type.Optional(
        Type.Boolean({
          description:
            "For run or wait: return at once; a message arrives in this session when the command exits, with exit code and output tail.",
        }),
      ),
      lines: Type.Optional(Type.Number({ description: "Scrollback lines to capture or inspect" })),
      source: Type.Optional(SourceEnum),
      raw: Type.Optional(Type.Boolean({ description: "Disable ANSI stripping for read/watch" })),
      text: Type.Optional(
        Type.String({
          description:
            "Literal text to send without Enter (for send action). Use run if you want text plus Enter atomically.",
        }),
      ),
      keys: Type.Optional(
        Type.String({
          description:
            "Keys to send, space-separated (for send action). Examples: C-c, Enter, q, y",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory for workspace_create, tab_create, and pane_split where supported",
        }),
      ),
      focus: Type.Optional(
        Type.Boolean({
          description:
            "Explicitly change focus for create/focus actions. Defaults should preserve current focus.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({ description: "Force worktree_remove when Git refuses a dirty checkout" }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const requestCwd = ctx.cwd;
      const currentPane = await getCurrentPaneInfo(signal);
      const currentPaneId = currentPane.pane_id;
      const currentWorkspaceId = currentPane.workspace_id;

      switch (params.action) {
        case "list": {
          const panes = await getWorkspacePanes(currentWorkspaceId, signal);
          const aliasByPaneId = new Map<string, string>();
          for (const [alias, managed] of managedPanes.entries()) {
            if (managed.workspaceId === currentWorkspaceId)
              aliasByPaneId.set(managed.paneId, alias);
          }

          const text = panes.length
            ? panes
                .map((pane) => summarizePane(pane, aliasByPaneId.get(pane.pane_id), currentPaneId))
                .join("\n")
            : "No panes in current workspace.";

          return {
            content: [{ type: "text", text }],
            details: withSnapshot({
              action: "list",
              panes,
              currentPaneId,
              workspaceId: currentWorkspaceId,
              paneAliases: Object.fromEntries(aliasByPaneId),
            }),
          };
        }

        case "workspace_list": {
          const workspaces = await getWorkspaceList(signal);
          const text = workspaces.length
            ? workspaces.map(summarizeWorkspace).join("\n")
            : "No workspaces.";
          return {
            content: [{ type: "text", text }],
            details: withSnapshot({ action: "workspace_list", workspaces }),
          };
        }

        case "workspace_create": {
          const created = expectResult(
            await herdr.call(
              "workspace.create",
              {
                cwd: absolutePath(params.cwd, requestCwd),
                label: params.label,
                focus: params.focus === true,
              },
              { signal },
            ),
            "workspace_created",
          );
          const workspace = created.workspace;
          const rootPane = created.root_pane;
          if (params.pane && rootPane) {
            recordAlias(params.pane, rootPane.pane_id, workspace.workspace_id);
          }
          const aliasText = params.pane && rootPane ? `, aliased as '${params.pane}'` : "";
          const rootPaneText = rootPane ? `, root pane ${rootPane.pane_id}${aliasText}` : "";
          return {
            content: [
              {
                type: "text",
                text: `Created workspace '${workspace.label}' (${workspace.workspace_id})${rootPaneText}`,
              },
            ],
            details: withSnapshot({
              action: "workspace_create",
              workspace,
              rootPaneId: rootPane?.pane_id,
              pane: params.pane,
            }),
          };
        }

        case "workspace_focus": {
          const workspaceId = params.workspace;
          if (!workspaceId) throw new Error("'workspace' is required for workspace_focus");
          const workspace = expectResult(
            await herdr.call("workspace.focus", { workspace_id: workspaceId }, { signal }),
            "workspace_info",
          ).workspace;
          return {
            content: [{ type: "text", text: `Focused workspace '${workspace.label}'` }],
            details: withSnapshot({ action: "workspace_focus", workspace }),
          };
        }

        case "worktree_list": {
          const result = expectResult(
            await herdr.call(
              "worktree.list",
              {
                workspace_id: params.workspace,
                cwd: params.workspace ? undefined : absolutePath(params.cwd, requestCwd),
              },
              { signal },
            ),
            "worktree_list",
          );
          const worktrees = result.worktrees;
          const text = worktrees.length
            ? worktrees.map(summarizeWorktree).join("\n")
            : "No worktrees.";
          return {
            content: [{ type: "text", text }],
            details: withSnapshot({ action: "worktree_list", worktrees, source: result.source }),
          };
        }

        case "worktree_create": {
          const created = expectResult(
            await herdr.call(
              "worktree.create",
              {
                workspace_id: params.workspace,
                cwd: params.workspace ? undefined : absolutePath(params.cwd, requestCwd),
                branch: params.branch,
                base: params.base,
                path: absolutePath(params.path, requestCwd),
                label: params.label,
                focus: params.focus === true,
              },
              { signal },
            ),
            "worktree_created",
          );
          const { workspace, worktree, root_pane: rootPane } = created;
          if (params.pane && rootPane && workspace)
            recordAlias(params.pane, rootPane.pane_id, workspace.workspace_id);
          const label =
            worktree?.branch ||
            params.branch ||
            worktree?.path ||
            params.path ||
            workspace?.label ||
            "worktree";
          const workspaceText = workspace ? `, workspace ${workspace.workspace_id}` : "";
          const aliasText =
            params.pane && rootPane ? `, root pane aliased as '${params.pane}'` : "";
          return {
            content: [
              { type: "text", text: `Created worktree '${label}'${workspaceText}${aliasText}` },
            ],
            details: withSnapshot({ action: "worktree_create", ...created, pane: params.pane }),
          };
        }

        case "worktree_open": {
          if (!params.path && !params.branch)
            throw new Error("'path' or 'branch' is required for worktree_open");
          const opened = expectResult(
            await herdr.call(
              "worktree.open",
              {
                workspace_id: params.workspace,
                cwd: params.workspace ? undefined : absolutePath(params.cwd, requestCwd),
                path: absolutePath(params.path, requestCwd),
                branch: params.branch,
                label: params.label,
                focus: params.focus === true,
              },
              { signal },
            ),
            "worktree_opened",
          );
          const { workspace, root_pane: rootPane } = opened;
          if (params.pane && rootPane && workspace)
            recordAlias(params.pane, rootPane.pane_id, workspace.workspace_id);
          const label =
            opened.worktree.branch ||
            params.branch ||
            opened.worktree.path ||
            params.path ||
            workspace.label ||
            "worktree";
          const workspaceText = workspace ? `, workspace ${workspace.workspace_id}` : "";
          return {
            content: [{ type: "text", text: `Opened worktree '${label}'${workspaceText}` }],
            details: withSnapshot({ action: "worktree_open", ...opened, pane: params.pane }),
          };
        }

        case "worktree_remove": {
          const workspaceId = params.workspace;
          if (!workspaceId) throw new Error("'workspace' is required for worktree_remove");
          const removed = expectResult(
            await herdr.call(
              "worktree.remove",
              { workspace_id: workspaceId, force: params.force === true },
              { signal },
            ),
            "worktree_removed",
          );
          for (const [alias, managed] of Array.from(managedPanes.entries())) {
            if (managed.workspaceId === workspaceId) forgetAlias(alias);
          }
          return {
            content: [
              {
                type: "text",
                text: `Removed worktree workspace ${workspaceId}; branch was not deleted.`,
              },
            ],
            details: withSnapshot({ action: "worktree_remove", workspaceId, ...removed }),
          };
        }

        case "tab_list": {
          const workspaceId = params.workspace ?? currentWorkspaceId;
          const tabs = await getTabList(workspaceId, signal);
          const text = tabs.length ? tabs.map(summarizeTab).join("\n") : "No tabs.";
          return {
            content: [{ type: "text", text }],
            details: withSnapshot({ action: "tab_list", tabs, workspaceId }),
          };
        }

        case "tab_create": {
          const workspaceId = params.workspace ?? currentWorkspaceId;
          const created = expectResult(
            await herdr.call(
              "tab.create",
              {
                workspace_id: workspaceId,
                cwd: absolutePath(params.cwd, requestCwd),
                label: params.label,
                focus: params.focus === true,
              },
              { signal },
            ),
            "tab_created",
          );
          const { tab, root_pane: rootPane } = created;
          if (params.pane && rootPane) {
            recordAlias(params.pane, rootPane.pane_id, tab.workspace_id);
          }
          const aliasText = params.pane && rootPane ? `, aliased as '${params.pane}'` : "";
          const rootPaneText = rootPane ? `, root pane ${rootPane.pane_id}${aliasText}` : "";
          return {
            content: [
              { type: "text", text: `Created tab '${tab.label}' (${tab.tab_id})${rootPaneText}` },
            ],
            details: withSnapshot({
              action: "tab_create",
              tab,
              rootPaneId: rootPane?.pane_id,
              pane: params.pane,
            }),
          };
        }

        case "tab_focus": {
          const tabId = params.tab;
          if (!tabId) throw new Error("'tab' is required for tab_focus");
          const tab = expectResult(
            await herdr.call("tab.focus", { tab_id: tabId }, { signal }),
            "tab_info",
          ).tab;
          return {
            content: [{ type: "text", text: `Focused tab '${tab.label}'` }],
            details: withSnapshot({ action: "tab_focus", tab }),
          };
        }

        case "tab_close": {
          const tabId = params.tab;
          if (!tabId) throw new Error("'tab' is required for tab_close");
          if (tabId === currentPane.tab_id)
            throw new Error("Refusing to close the tab pi is running in.");

          const tabs = await getTabList(currentWorkspaceId, signal);
          const tab = tabs.find((candidate) => candidate.tab_id === tabId);
          if (!tab) throw new Error(`Tab '${tabId}' not found in the current workspace.`);
          const paneIds = new Set(
            (await getWorkspacePanes(currentWorkspaceId, signal))
              .filter((pane) => pane.tab_id === tabId)
              .map((pane) => pane.pane_id),
          );
          expectResult(await herdr.call("tab.close", { tab_id: tabId }, { signal }), "ok");
          for (const paneId of paneIds) {
            abortPendingRun(paneId);
            lastCommandByPane.delete(paneId);
          }
          for (const [alias, managed] of Array.from(managedPanes.entries())) {
            if (paneIds.has(managed.paneId)) forgetAlias(alias);
          }
          return {
            content: [{ type: "text", text: `Closed tab '${tab.label}' (${tabId})` }],
            details: withSnapshot({ action: "tab_close", tab, tabId }),
          };
        }

        case "focus": {
          if (params.tab) {
            const tab = expectResult(
              await herdr.call("tab.focus", { tab_id: params.tab }, { signal }),
              "tab_info",
            ).tab;
            return {
              content: [{ type: "text", text: `Focused tab '${tab.label}'` }],
              details: withSnapshot({ action: "focus", target: "tab", tab }),
            };
          }
          if (params.workspace) {
            const workspace = expectResult(
              await herdr.call("workspace.focus", { workspace_id: params.workspace }, { signal }),
              "workspace_info",
            ).workspace;
            return {
              content: [{ type: "text", text: `Focused workspace '${workspace.label}'` }],
              details: withSnapshot({ action: "focus", target: "workspace", workspace }),
            };
          }
          if (params.pane) {
            const resolved = await requirePaneRef(params.pane, currentWorkspaceId, signal);
            const pane = expectResult(
              await herdr.call("pane.focus", { pane_id: resolved.pane.pane_id }, { signal }),
              "pane_info",
            ).pane;
            return {
              content: [{ type: "text", text: `Focused pane '${pane.pane_id}'` }],
              details: withSnapshot({ action: "focus", target: "pane", paneId: pane.pane_id }),
            };
          }
          throw new Error("'workspace', 'tab', or 'pane' is required for focus");
        }

        case "pane_split": {
          rejectUnexpectedParams("pane_split", params, ["workspace", "tab"]);
          const paneRef = params.pane;
          if (!paneRef) {
            throw new Error(
              "'pane' is required for pane_split. Create a dedicated work tab first with tab_create and assign its root pane an alias.",
            );
          }
          const direction = params.direction ?? "right";

          const sourcePane = await requirePaneRef(paneRef, currentWorkspaceId, signal);
          if (sourcePane.pane.tab_id === currentPane.tab_id) {
            throw new Error(
              "Refusing to split a pane in Pi's tab. Create a dedicated work tab with tab_create, then split its root pane alias.",
            );
          }
          const splitPane = expectResult(
            await herdr.call(
              "pane.split",
              {
                target_pane_id: sourcePane.pane.pane_id,
                direction,
                cwd: absolutePath(params.cwd, requestCwd),
                focus: params.focus === true,
              },
              { signal },
            ),
            "pane_info",
          ).pane;
          if (params.newPane) {
            recordAlias(params.newPane, splitPane.pane_id, splitPane.workspace_id);
          }
          const enteredNetns = await enterPiNetnsInPane(splitPane.pane_id, signal);

          const sourceLabel = sourcePane.alias || paneRef;
          const aliasText = params.newPane ? `, aliased as '${params.newPane}'` : "";
          const netnsText = enteredNetns ? `, entered network namespace '${enteredNetns}'` : "";
          return {
            content: [
              {
                type: "text",
                text: `Created pane '${splitPane.pane_id}' by splitting '${sourceLabel}' ${direction}${aliasText}${netnsText}`,
              },
            ],
            details: withSnapshot({
              action: "pane_split",
              pane: sourceLabel,
              paneId: sourcePane.pane.pane_id,
              newPane: params.newPane || splitPane.pane_id,
              newPaneId: splitPane.pane_id,
              direction,
              workspaceId: splitPane.workspace_id,
              enteredNetns,
            }),
          };
        }

        case "run": {
          rejectUnexpectedParams("run", params, ["workspace", "tab"]);
          const paneRef = params.pane;
          const command = params.command;
          if (!paneRef) throw new Error("'pane' is required for run");
          if (!command) throw new Error("'command' is required for run");

          const targetPane = await requirePaneRef(paneRef, currentWorkspaceId, signal);
          const paneId = targetPane.pane.pane_id;
          const paneLabel = targetPane.alias || paneRef;
          abortPendingRun(paneId);

          if (params.wait !== true && params.notify !== true) {
            expectResult(
              await herdr.call(
                "pane.send_input",
                { pane_id: paneId, text: command, keys: ["Enter"] },
                { signal },
              ),
              "ok",
            );
            lastCommandByPane.set(paneId, command);

            await sleep(800, signal);
            const initialOutput = await readPane(
              paneId,
              {
                source: params.source ?? "recent",
                lines: params.lines ?? 20,
                raw: params.raw,
              },
              signal,
            );

            return {
              content: [
                {
                  type: "text",
                  text: `Started '${command}' in pane '${paneLabel}' (${paneId})\n\n${formatReadOutput(initialOutput)}`,
                },
              ],
              details: withSnapshot({
                action: "run",
                pane: paneLabel,
                paneId,
                command,
                workspaceId: currentWorkspaceId,
              }),
            };
          }

          const normalizedCommand = command.trim().replace(/;+$/, "").trimEnd();
          if (!normalizedCommand) throw new Error("'command' is required for run");
          const runId = randomBytes(3).toString("hex");
          const marker = normalizedCommand.endsWith("&") ? null : `__pi_rc_${runId}`;
          const submittedCommand = marker
            ? `{ ${normalizedCommand}; }; echo "${marker}=$?"`
            : normalizedCommand;
          const pendingRun: PendingRun = {
            paneId,
            paneLabel,
            runId,
            command: normalizedCommand,
            marker,
            startedAt: Date.now(),
            abort: new AbortController(),
          };

          expectResult(
            await herdr.call(
              "pane.send_input",
              { pane_id: paneId, text: submittedCommand, keys: ["Enter"] },
              { signal },
            ),
            "ok",
          );
          lastCommandByPane.set(paneId, normalizedCommand);
          pendingRuns.set(paneId, pendingRun);

          const lines = params.lines ?? 60;
          if (params.wait !== true) {
            startNotifier(pendingRun, lines, 1_000);
            return {
              content: [
                {
                  type: "text",
                  text: `Started '${normalizedCommand}' in pane '${paneLabel}' (${paneId}); a message will arrive when it exits.`,
                },
              ],
              details: withSnapshot({
                action: "run",
                pane: paneLabel,
                paneId,
                command: normalizedCommand,
                exitCode: null,
                elapsedMs: Date.now() - pendingRun.startedAt,
                state: "running",
              }),
            };
          }

          const publishRunUpdate = () => {
            onUpdate?.({
              content: [{ type: "text", text: `Waiting for ${paneLabel}...` }],
              details: withSnapshot({
                action: "run",
                pane: paneLabel,
                paneId,
                command: normalizedCommand,
                elapsedMs: Date.now() - pendingRun.startedAt,
                state: "running",
              }),
            });
          };
          publishRunUpdate();
          const updateTimer = onUpdate ? setInterval(publishRunUpdate, 1_000) : null;

          let completion: Completion;
          try {
            completion = await waitForCompletion(
              pendingRun,
              lines,
              params.timeout ?? DEFAULT_COMPLETION_TIMEOUT_MS,
              1_000,
              signal,
            );
          } finally {
            if (updateTimer) clearInterval(updateTimer);
          }

          if (completion.kind === "done") {
            if (pendingRuns.get(paneId) === pendingRun) {
              pendingRun.abort.abort();
              pendingRuns.delete(paneId);
            }
            return doneResult("run", pendingRun, completion, false);
          }

          const notifierStarted = params.notify === true;
          if (notifierStarted) startNotifier(pendingRun, lines, 0);
          return runningResult("run", pendingRun, completion, false, notifierStarted);
        }

        case "read": {
          rejectUnexpectedParams("read", params, ["workspace", "tab"]);
          const paneRef = params.pane;
          if (!paneRef) throw new Error("'pane' is required for read");

          const resolved = await requirePaneRef(paneRef, currentWorkspaceId, signal);

          const output = await readPane(
            resolved.pane.pane_id,
            {
              source: params.source ?? "recent",
              lines: params.lines ?? 20,
              raw: params.raw,
            },
            signal,
          );

          return {
            content: [{ type: "text", text: formatReadOutput(output) }],
            details: withSnapshot({
              action: "read",
              pane: resolved.alias || paneRef,
              paneId: resolved.pane.pane_id,
              source: params.source ?? "recent",
            }),
          };
        }

        case "watch": {
          rejectUnexpectedParams("watch", params, ["workspace", "tab"]);
          const paneRef = params.pane;
          const match = params.match;
          if (!paneRef) throw new Error("'pane' is required for watch");
          if (!match) throw new Error("'match' is required for watch");

          const resolved = await requirePaneRef(paneRef, currentWorkspaceId, signal);
          const paneLabel = resolved.alias || paneRef;
          const startTime = Date.now();

          const publishWatchUpdate = () => {
            onUpdate?.({
              content: [{ type: "text", text: `Watching ${paneLabel}...` }],
              details: withSnapshot({
                action: "watch",
                pane: paneLabel,
                paneId: resolved.pane.pane_id,
                match,
                elapsed: Math.floor((Date.now() - startTime) / 1000),
              }),
            });
          };

          publishWatchUpdate();
          const updateTimer = onUpdate ? setInterval(publishWatchUpdate, 1000) : null;

          try {
            const matched = expectResult(
              await herdr.call(
                "pane.wait_for_output",
                {
                  pane_id: resolved.pane.pane_id,
                  source: protocolReadSource(params.source, params.lines),
                  lines: params.lines,
                  match: { type: params.regex ? "regex" : "substring", value: match },
                  timeout_ms: params.timeout,
                  strip_ansi: params.raw !== true,
                },
                {
                  signal,
                  timeoutMs: params.timeout != null ? params.timeout + 5_000 : undefined,
                },
              ),
              "output_matched",
            );
            const commandPrefix = lastCommandByPane.get(resolved.pane.pane_id)?.trim().slice(0, 30);
            if (
              matched.matched_line &&
              (matched.matched_line.includes("$?") ||
                (commandPrefix && matched.matched_line.includes(commandPrefix)))
            ) {
              throw new Error(
                `watch matched the shell's echo of the command line, not command output: ${matched.matched_line}. Use run with wait or notify for completion; watch is for readiness patterns only.`,
              );
            }
            const matchedLine = matched.matched_line ?? match;
            const text = matched.read.text ? formatReadOutput(matched.read.text) : matchedLine;

            return {
              content: [{ type: "text", text: `Matched: ${matchedLine}\n\n${text}` }],
              details: withSnapshot({
                action: "watch",
                pane: paneLabel,
                paneId: resolved.pane.pane_id,
                matchedLine,
                elapsed: Math.floor((Date.now() - startTime) / 1000),
              }),
            };
          } finally {
            if (updateTimer) clearInterval(updateTimer);
          }
        }

        case "wait": {
          rejectUnexpectedParams("wait", params, ["workspace", "tab"]);
          const paneRef = params.pane;
          if (!paneRef) throw new Error("'pane' is required for wait");

          const resolved = await requirePaneRef(paneRef, currentWorkspaceId, signal);
          const paneId = resolved.pane.pane_id;
          const paneLabel = resolved.alias || paneRef;
          const registeredRun = pendingRuns.get(paneId);
          const untracked = registeredRun == null;
          const pendingRun: PendingRun = registeredRun ?? {
            paneId,
            paneLabel,
            runId: randomBytes(3).toString("hex"),
            command: "the running command",
            marker: null,
            startedAt: Date.now(),
            abort: new AbortController(),
          };
          const lines = params.lines ?? 60;

          if (params.notify === true) {
            const completion = await probe(pendingRun, lines, signal);
            if (completion.kind === "done") {
              if (pendingRuns.get(paneId) === pendingRun) {
                pendingRun.abort.abort();
                pendingRuns.delete(paneId);
              }
              return doneResult("wait", pendingRun, completion, untracked);
            }
            if (untracked) pendingRuns.set(paneId, pendingRun);
            startNotifier(pendingRun, lines, 0);
            return runningResult("wait", pendingRun, completion, untracked, true);
          }

          const publishWaitUpdate = () => {
            onUpdate?.({
              content: [{ type: "text", text: `Waiting for ${paneLabel}...` }],
              details: withSnapshot({
                action: "wait",
                pane: paneLabel,
                paneId,
                command: pendingRun.command,
                elapsedMs: Date.now() - pendingRun.startedAt,
                state: "running",
              }),
            });
          };
          publishWaitUpdate();
          const updateTimer = onUpdate ? setInterval(publishWaitUpdate, 1_000) : null;

          let completion: Completion;
          try {
            completion = await waitForCompletion(
              pendingRun,
              lines,
              params.timeout ?? DEFAULT_COMPLETION_TIMEOUT_MS,
              0,
              signal,
            );
          } finally {
            if (updateTimer) clearInterval(updateTimer);
          }

          if (completion.kind === "done") {
            if (pendingRuns.get(paneId) === pendingRun) {
              pendingRun.abort.abort();
              pendingRuns.delete(paneId);
            }
            return doneResult("wait", pendingRun, completion, untracked);
          }
          return runningResult("wait", pendingRun, completion, untracked, false);
        }

        case "wait_agent": {
          rejectUnexpectedParams("wait_agent", params, ["workspace", "tab"]);
          throwIfAborted(signal, "wait_agent");
          const paneRefs = params.panes?.length ? params.panes : params.pane ? [params.pane] : [];
          const statuses = params.statuses?.length
            ? params.statuses
            : params.status
              ? [params.status]
              : [];
          const mode = params.mode ?? "all";
          if (!paneRefs.length) throw new Error("'pane' or 'panes' is required for wait_agent");
          if (!statuses.length)
            throw new Error("'status' or 'statuses' is required for wait_agent");

          const resolvedPanes: Array<{ pane: PaneInfo; aliasOrRef: string }> = [];
          for (const paneRef of paneRefs) {
            throwIfAborted(signal, "wait_agent");
            const resolved = await requirePaneRef(paneRef, currentWorkspaceId, signal);
            resolvedPanes.push({
              pane: resolved.pane,
              aliasOrRef: resolved.alias || paneRef,
            });
          }

          const controllers = resolvedPanes.map(() => new AbortController());
          const abortWaits = () => controllers.forEach((controller) => controller.abort());
          signal?.addEventListener("abort", abortWaits, { once: true });
          try {
            const waits = resolvedPanes.map((resolved, index) =>
              herdr
                .call(
                  "agent.wait",
                  {
                    target: resolved.pane.pane_id,
                    until: statuses,
                    timeout_ms: params.timeout,
                  },
                  {
                    signal: controllers[index]?.signal,
                    timeoutMs: params.timeout != null ? params.timeout + 5_000 : undefined,
                  },
                )
                .then((result) => expectResult(result, "agent_info")),
            );
            if (mode === "all") await Promise.all(waits);
            else await Promise.any(waits);
          } finally {
            signal?.removeEventListener("abort", abortWaits);
            abortWaits();
          }

          const snapshot = await Promise.all(
            resolvedPanes.map(async (resolved) => {
              const pane = await getPaneInfo(resolved.pane.pane_id, signal);
              if (!pane) throw new Error(`Pane '${resolved.aliasOrRef}' no longer exists.`);
              return {
                pane: resolved.aliasOrRef,
                paneId: pane.pane_id,
                status: pane.agent_status,
                agent: pane.agent,
              };
            }),
          );
          const summary = snapshot.map((item) => `${item.pane}=${item.status}`).join(", ");
          return {
            content: [
              {
                type: "text",
                text: `wait_agent satisfied (${mode}: ${formatStatusList(statuses)})\n\n${summary}`,
              },
            ],
            details: withSnapshot({
              action: "wait_agent",
              pane: paneRefs.length === 1 ? resolvedPanes[0]?.aliasOrRef : undefined,
              panes: snapshot.map((item) => item.pane),
              paneIds: snapshot.map((item) => item.paneId),
              status:
                paneRefs.length === 1 && statuses.length === 1 ? snapshot[0]?.status : undefined,
              statuses,
              mode,
              agents: snapshot.map((item) => item.agent).filter(Boolean),
              snapshot,
            }),
          };
        }

        case "send": {
          rejectUnexpectedParams("send", params, ["workspace", "tab"]);
          const paneRef = params.pane;
          if (!paneRef) throw new Error("'pane' is required for send");
          if (!params.text && !params.keys)
            throw new Error("'text' or 'keys' is required for send");

          const resolved = await requirePaneRef(paneRef, currentWorkspaceId, signal);

          if (params.text) {
            expectResult(
              await herdr.call(
                "pane.send_text",
                { pane_id: resolved.pane.pane_id, text: params.text },
                { signal },
              ),
              "ok",
            );
          }
          if (params.keys) {
            const keys = params.keys.split(/\s+/).filter(Boolean);
            expectResult(
              await herdr.call(
                "pane.send_keys",
                { pane_id: resolved.pane.pane_id, keys },
                { signal },
              ),
              "ok",
            );
          }

          const desc = [params.text && `"${params.text}"`, params.keys].filter(Boolean).join(" + ");
          return {
            content: [
              { type: "text", text: `Sent ${desc} to pane '${resolved.alias || paneRef}'` },
            ],
            details: withSnapshot({
              action: "send",
              pane: resolved.alias || paneRef,
              paneId: resolved.pane.pane_id,
              text: params.text,
              keys: params.keys,
            }),
          };
        }

        case "stop": {
          rejectUnexpectedParams("stop", params, ["workspace", "tab"]);
          const paneRef = params.pane;
          if (!paneRef) throw new Error("'pane' is required for stop");

          const resolved = await requirePaneRef(paneRef, currentWorkspaceId, signal);
          if (resolved.pane.pane_id === currentPaneId) {
            throw new Error("Refusing to close the pane pi is running in.");
          }

          expectResult(
            await herdr.call("pane.close", { pane_id: resolved.pane.pane_id }, { signal }),
            "ok",
          );
          abortPendingRun(resolved.pane.pane_id);
          lastCommandByPane.delete(resolved.pane.pane_id);
          if (resolved.alias) forgetAlias(resolved.alias);

          return {
            content: [{ type: "text", text: `Closed pane '${resolved.alias || paneRef}'` }],
            details: withSnapshot({
              action: "stop",
              pane: resolved.alias || paneRef,
              paneId: resolved.pane.pane_id,
            }),
          };
        }

        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },

    renderCall(args, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      let text = theme.fg("toolTitle", theme.bold("herdr "));
      text += theme.fg("accent", args.action || "?");
      if (args.workspace) text += theme.fg("muted", ` ${args.workspace}`);
      if (args.tab) text += theme.fg("muted", ` ${args.tab}`);
      if (args.pane) text += theme.fg("muted", ` ${args.pane}`);
      if (Array.isArray(args.panes) && args.panes.length)
        text += theme.fg("muted", ` ${args.panes.join(",")}`);
      if (args.direction) text += theme.fg("dim", ` › ${args.direction}`);
      if (args.branch) text += theme.fg("dim", ` › ${args.branch}`);
      if (args.base) text += theme.fg("dim", ` from ${args.base}`);
      if (args.path) text += theme.fg("dim", ` @ ${args.path}`);
      if (args.command) text += theme.fg("dim", ` › ${args.command}`);
      if (args.newPane) text += theme.fg("muted", ` ${args.newPane}`);
      if (args.match) text += theme.fg("dim", ` › ${args.match}`);
      if (args.status) text += theme.fg("dim", ` › ${args.status}`);
      if (Array.isArray(args.statuses) && args.statuses.length)
        text += theme.fg("dim", ` › ${args.statuses.join("|")}`);
      if (args.mode) text += theme.fg("dim", ` ${args.mode}`);
      if (args.text) text += theme.fg("dim", ` › "${args.text}"`);
      if (args.keys) text += theme.fg("dim", ` › ${args.keys}`);
      if (args.wait) text += theme.fg("dim", " › wait");
      if (args.notify) text += theme.fg("dim", " › notify");

      component.setText(text);
      return component;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = result.details as Record<string, any> | undefined;
      const state = context.state as { watchElapsed?: number; completionElapsed?: number };
      if (context.args?.action === "watch") {
        if (isPartial) {
          state.watchElapsed = typeof details?.elapsed === "number" ? details.elapsed : 0;
          const pane = details?.pane || context.args?.pane || "?";
          return new Text(
            theme.fg("warning", `◌ watching ${pane}`) +
              theme.fg("dim", ` (${state.watchElapsed}s)`),
            0,
            0,
          );
        }
        delete state.watchElapsed;
      }
      if (context.args?.action === "run" || context.args?.action === "wait") {
        if (isPartial) {
          state.completionElapsed =
            typeof details?.elapsedMs === "number" ? Math.floor(details.elapsedMs / 1000) : 0;
          const pane = details?.pane || context.args?.pane || "?";
          return new Text(
            theme.fg("warning", `◌ waiting ${pane}`) +
              theme.fg("dim", ` (${state.completionElapsed}s)`),
            0,
            0,
          );
        }
        delete state.completionElapsed;
      }
      if (!details) {
        const content = result.content?.[0];
        return new Text(content?.type === "text" ? content.text : "", 0, 0);
      }

      switch (details.action) {
        case "pane_split": {
          let text = theme.fg("accent", `▥ ${details.newPane || details.newPaneId}`);
          text += theme.fg("dim", ` ‹ ${details.direction} from ${details.pane}`);
          return new Text(text, 0, 0);
        }
        case "run":
        case "wait": {
          const content = result.content?.[0];
          const firstLine = content?.type === "text" ? (content.text.split("\n")[0] ?? "") : "";
          const color = details.state === "running" ? "warning" : "success";
          return new Text(theme.fg(color, firstLine), 0, 0);
        }
        case "read": {
          let text = theme.fg("accent", `📄 ${details.pane}`);
          if (expanded) {
            const content = result.content?.[0];
            if (content?.type === "text") {
              const outputLines = content.text.split("\n").slice(0, 40);
              text += "\n" + outputLines.map((line: string) => theme.fg("dim", line)).join("\n");
            }
          }
          return new Text(text, 0, 0);
        }
        case "watch": {
          let text = theme.fg("success", `✓ ${details.pane}`);
          text += theme.fg("dim", ` › ${details.matchedLine}`);
          if (typeof details.elapsed === "number")
            text += theme.fg("muted", ` (took ${details.elapsed}s)`);
          return new Text(text, 0, 0);
        }
        case "wait_agent": {
          const panes =
            Array.isArray(details.panes) && details.panes.length
              ? details.panes
              : details.pane
                ? [details.pane]
                : [];
          const statuses =
            Array.isArray(details.statuses) && details.statuses.length
              ? details.statuses
              : details.status
                ? [details.status]
                : [];
          let text = theme.fg("success", `◎ ${panes.join(", ")}`);
          if (statuses.length) text += theme.fg("dim", ` › ${statuses.join("|")}`);
          if (details.mode) text += theme.fg("muted", ` (${details.mode})`);
          return new Text(text, 0, 0);
        }
        case "send": {
          const desc = [details.text && `"${details.text}"`, details.keys]
            .filter(Boolean)
            .join(" + ");
          return new Text(theme.fg("accent", `⏎ ${details.pane} › ${desc}`), 0, 0);
        }
        case "stop": {
          return new Text(theme.fg("warning", `■ ${details.pane}`), 0, 0);
        }
        case "workspace_create":
        case "workspace_focus": {
          return new Text(
            theme.fg("accent", `▣ ${details.workspace?.label || details.workspace?.workspace_id}`),
            0,
            0,
          );
        }
        case "worktree_create":
        case "worktree_open": {
          const label =
            details.worktree?.branch ||
            details.worktree?.path ||
            details.workspace?.label ||
            details.workspace?.workspace_id ||
            "worktree";
          return new Text(theme.fg("accent", `⑂ ${label}`), 0, 0);
        }
        case "worktree_remove": {
          return new Text(
            theme.fg(
              "warning",
              `⑂ removed ${details.workspaceId || details.workspace?.workspace_id}`,
            ),
            0,
            0,
          );
        }
        case "tab_create":
        case "tab_focus": {
          return new Text(
            theme.fg("accent", `▤ ${details.tab?.label || details.tab?.tab_id}`),
            0,
            0,
          );
        }
        case "focus": {
          return new Text(theme.fg("accent", `◎ ${details.target}`), 0, 0);
        }
        case "workspace_list": {
          const workspaces = details.workspaces as WorkspaceInfo[];
          if (!workspaces?.length) return new Text(theme.fg("dim", "no workspaces"), 0, 0);
          const lines = workspaces.map((workspace) => {
            const dot = statusDot(theme, workspace.agent_status);
            const label = theme.fg(
              workspace.focused ? "accent" : "muted",
              workspace.label || workspace.workspace_id,
            );
            const extra = [
              workspace.workspace_id,
              workspace.agent_status !== "unknown" ? workspace.agent_status : null,
            ]
              .filter(Boolean)
              .join(" ");
            return `${dot} ${label}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
          });
          return new Text(lines.join("\n"), 0, 0);
        }
        case "worktree_list": {
          const worktrees = details.worktrees as WorktreeInfo[];
          if (!worktrees?.length) return new Text(theme.fg("dim", "no worktrees"), 0, 0);
          const lines = worktrees.map((worktree) => {
            const label = theme.fg(
              worktree.open_workspace_id ? "accent" : "muted",
              worktree.branch || worktree.label || worktree.path,
            );
            const extra = [
              worktree.open_workspace_id,
              worktree.is_detached ? "detached" : null,
              worktree.path,
            ]
              .filter(Boolean)
              .join(" ");
            return `⑂ ${label}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
          });
          return new Text(lines.join("\n"), 0, 0);
        }
        case "tab_list": {
          const tabs = details.tabs as TabInfo[];
          if (!tabs?.length) return new Text(theme.fg("dim", "no tabs"), 0, 0);
          const lines = tabs.map((tab) => {
            const dot = statusDot(theme, tab.agent_status);
            const label = theme.fg(tab.focused ? "accent" : "muted", tab.label || tab.tab_id);
            const extra = [tab.tab_id, tab.agent_status !== "unknown" ? tab.agent_status : null]
              .filter(Boolean)
              .join(" ");
            return `${dot} ${label}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
          });
          return new Text(lines.join("\n"), 0, 0);
        }
        case "list": {
          const panes = details.panes as PaneInfo[];
          if (!panes?.length) return new Text(theme.fg("dim", "no panes"), 0, 0);
          const paneAliases = (details.paneAliases || {}) as Record<string, string>;
          const lines = panes.map((pane) => {
            const dot = statusDot(theme, pane.agent_status);
            const label = paneAliases[pane.pane_id]
              ? theme.fg("accent", paneAliases[pane.pane_id])
              : theme.fg("muted", pane.pane_id);
            const extra = [pane.agent, pane.agent_status !== "unknown" ? pane.agent_status : null]
              .filter(Boolean)
              .join(" ");
            return `${dot} ${label}${extra ? ` ${theme.fg("dim", extra)}` : ""}`;
          });
          return new Text(lines.join("\n"), 0, 0);
        }
        default: {
          const content = result.content?.[0];
          return new Text(content?.type === "text" ? content.text : "", 0, 0);
        }
      }
    },
  });
}
