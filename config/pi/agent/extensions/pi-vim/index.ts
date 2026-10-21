import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type EditorComponent,
  type EditorTheme,
  matchesKey,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { renderBar, renderStatusLine } from "./status-line.ts";
import {
  countdown,
  fetchUsageWindows,
  USAGE_SOURCES,
  usageProviderId,
  type UsageLayout,
  type UsageSource,
  type UsageWindow,
} from "./usage.ts";

type VimMode = "normal" | "insert";
type PiEditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

interface VimViewport extends TUI {
  scrollBy(lines: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
}

function vimViewport(tui: TUI): VimViewport | undefined {
  const candidate = tui as Partial<VimViewport>;
  if (
    tui.mode !== "fullscreen" ||
    typeof candidate.scrollBy !== "function" ||
    typeof candidate.scrollToTop !== "function" ||
    typeof candidate.scrollToBottom !== "function"
  ) {
    return undefined;
  }
  return candidate as VimViewport;
}

function modeChip(theme: Theme, mode: VimMode, branch: string | undefined): string {
  const modeLabel = mode === "normal" ? "NORMAL" : "INSERT";
  const modeColor = mode === "normal" ? "accent" : "success";
  const modeSegment = theme.inverse(theme.bold(theme.fg(modeColor, ` ${modeLabel} `)));
  if (!branch) return modeSegment;
  const branchSegment = theme.bg("selectedBg", theme.fg("text", `  ${branch} `));
  return `${modeSegment}${branchSegment}`;
}

const USAGE_REFRESH_INTERVAL_MS = 5 * 60_000;
const WINDOW_SEPARATOR = "\ue0b1";

type UsageSnapshot = {
  providerId: string;
  source: UsageSource;
  windows: UsageWindow[];
};

function usageColor(percent: number): "error" | "warning" | "success" {
  if (percent >= 92) return "error";
  if (percent >= 85) return "warning";
  return "success";
}

function usageWindow(theme: Theme, window: UsageWindow, now: number, layout: UsageLayout): string {
  const color = usageColor(window.percent);
  const parts = [theme.fg("dim", window.label)];
  if (layout === "bars") parts.push(renderBar(theme, window.percent, color));
  parts.push(theme.fg(layout === "compact" ? color : "dim", `${Math.round(window.percent)}%`));
  const reset = countdown(window.resetAt, now);
  if (reset !== undefined) parts.push(theme.fg("dim", reset));
  return parts.join(" ");
}

function usageSegment(
  theme: Theme,
  snapshot: UsageSnapshot | undefined,
  providerId: string | undefined,
  now: number,
): string {
  if (
    snapshot === undefined ||
    snapshot.providerId !== providerId ||
    snapshot.windows.length === 0
  ) {
    return "";
  }
  const separator = ` ${theme.fg("dim", WINDOW_SEPARATOR)} `;
  const windows = snapshot.windows.map((window) =>
    usageWindow(theme, window, now, snapshot.source.layout),
  );
  return ` ${theme.fg("accent", snapshot.source.label)} ${windows.join(separator)}`;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function addUsage(
  totals: UsageTotals,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  },
) {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

function sanitizeStatus(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function isPrintableInput(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 32;
}

export default function piVim(pi: ExtensionAPI) {
  let previousFactory: PiEditorFactory | undefined;
  let activeFactory: PiEditorFactory | undefined;
  let restoreBindings: (() => void) | undefined;
  let usageSnapshot: UsageSnapshot | undefined;
  let usageTui: TUI | undefined;
  let usageRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let usageFetchGeneration = 0;

  async function refreshUsage(ctx: ExtensionContext): Promise<void> {
    const generation = ++usageFetchGeneration;
    const providerId = usageProviderId(ctx.model);
    const source = providerId === undefined ? undefined : USAGE_SOURCES.get(providerId);
    if (providerId === undefined || source === undefined) {
      usageSnapshot = undefined;
      usageTui?.requestRender();
      return;
    }
    const windows = await fetchUsageWindows(providerId, () =>
      ctx.modelRegistry.getApiKeyForProvider(providerId),
    );
    if (generation !== usageFetchGeneration) return;
    usageSnapshot = { providerId, source, windows };
    usageTui?.requestRender();
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    let mode: VimMode = "normal";
    let pendingG = false;
    const previousEditorFactory = ctx.ui.getEditorComponent();

    const editorFactory: PiEditorFactory = (tui, editorTheme, keybindings) => {
      const editor: EditorComponent = previousEditorFactory
        ? previousEditorFactory(tui, editorTheme, keybindings)
        : new CustomEditor(tui, editorTheme, keybindings);
      const viewport = vimViewport(tui);
      const insertBindings: ReturnType<KeybindingsManager["getUserBindings"]> = {
        ...keybindings.getUserBindings(),
        "tui.altScreen.halfPageUp": [],
        "tui.altScreen.halfPageDown": [],
      };
      const normalBindings: ReturnType<KeybindingsManager["getUserBindings"]> = {
        ...insertBindings,
        "tui.altScreen.halfPageUp": "ctrl+u",
        "tui.altScreen.halfPageDown": "ctrl+d",
      };
      const originalHandleInput = editor.handleInput.bind(editor);

      const setMode = (nextMode: VimMode) => {
        mode = nextMode;
        pendingG = false;
        keybindings.setUserBindings(mode === "normal" ? normalBindings : insertBindings);
        editor.invalidate();
        tui.requestRender();
      };

      editor.handleInput = (data: string) => {
        if (mode === "insert") {
          if (matchesKey(data, "escape")) {
            setMode("normal");
            return;
          }
          originalHandleInput(data);
          return;
        }

        if (pendingG) {
          pendingG = false;
          if (matchesKey(data, "g")) {
            viewport?.scrollToTop();
            tui.requestRender();
            return;
          }
        }

        if (matchesKey(data, "shift+g")) {
          viewport?.scrollToBottom();
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "g")) {
          pendingG = true;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "j")) {
          viewport?.scrollBy(1);
          return;
        }
        if (matchesKey(data, "k")) {
          viewport?.scrollBy(-1);
          return;
        }
        if (matchesKey(data, "i")) {
          setMode("insert");
          return;
        }
        if (isPrintableInput(data)) return;

        originalHandleInput(data);
      };

      setMode("normal");
      restoreBindings = () => keybindings.setUserBindings(insertBindings);
      return editor;
    };

    previousFactory = previousEditorFactory;
    activeFactory = editorFactory;
    let footerDataRef: ReadonlyFooterDataProvider | undefined;
    ctx.ui.setEditorComponent(editorFactory);
    ctx.ui.setFooter((tui, _theme, footerData) => {
      usageTui = tui;
      footerDataRef = footerData;
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        render(width: number): string[] {
          const theme = ctx.ui.theme;
          const statuses = footerData.getExtensionStatuses();
          const otherStatuses = Array.from(statuses.entries())
            .filter(([key]) => key !== "netns" && key !== "mcp")
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, text]) => sanitizeStatus(text));
          const branch = footerData.getGitBranch();
          const extensionStatus = otherStatuses.length
            ? theme.fg("muted", ` ${otherStatuses.join(" ")}`)
            : "";
          const now = Math.floor(Date.now() / 1000);
          const usage = usageSegment(theme, usageSnapshot, usageProviderId(ctx.model), now);
          const vimStatus = `${modeChip(theme, mode, branch ?? undefined)}${usage}${extensionStatus}`;

          return [truncateToWidth(vimStatus, width, "")];
        },
        invalidate() {
          tui.requestRender();
        },
        dispose() {
          unsubscribe();
        },
      };
    });
    ctx.ui.setWidget(
      "pi-vim-status-line",
      (_tui, theme) => ({
        render(width: number): string[] {
          const totals: UsageTotals = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
          };
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              addUsage(totals, entry.message.usage);
            } else if (
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.usage
            ) {
              addUsage(totals, entry.message.usage);
            } else if (
              (entry.type === "branch_summary" || entry.type === "compaction") &&
              entry.usage
            ) {
              addUsage(totals, entry.usage);
            }
          }
          const context = ctx.getContextUsage();
          const model = ctx.model;
          const netns = footerDataRef?.getExtensionStatuses().get("netns");
          return [
            renderStatusLine(
              {
                model: (model?.name ?? model?.id ?? "no-model").replace(/^Claude /, ""),
                reasoning: model?.reasoning ?? false,
                thinkingLevel: ctx.thinkingLevel ?? "off",
                cwd: ctx.sessionManager.getCwd(),
                contextPercent: context?.percent ?? null,
                contextTokens: context?.tokens ?? null,
                contextWindow: context?.contextWindow ?? model?.contextWindow ?? 0,
                cost: totals.cost,
                netns: netns ? sanitizeStatus(netns) : undefined,
              },
              theme,
              width,
            ),
          ];
        },
        invalidate() {},
      }),
      { placement: "aboveEditor" },
    );
    if (usageRefreshTimer !== undefined) clearInterval(usageRefreshTimer);
    usageRefreshTimer = setInterval(() => {
      void refreshUsage(ctx);
    }, USAGE_REFRESH_INTERVAL_MS);
    void refreshUsage(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    void refreshUsage(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    usageSnapshot = undefined;
    usageFetchGeneration++;
    restoreBindings?.();
    restoreBindings = undefined;
    if (usageRefreshTimer !== undefined) {
      clearInterval(usageRefreshTimer);
      usageRefreshTimer = undefined;
    }
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("pi-vim-status-line", undefined);
    ctx.ui.setFooter(undefined);
    if (activeFactory && ctx.ui.getEditorComponent() === activeFactory) {
      ctx.ui.setEditorComponent(previousFactory);
    }
    activeFactory = undefined;
    previousFactory = undefined;
    usageTui = undefined;
  });
}
