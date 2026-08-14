import {
  CustomEditor,
  type ExtensionAPI,
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
  visibleWidth,
} from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatDirectory(cwd: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const insideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));
  if (!insideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function alignSides(left: string, right: string, width: number): string {
  if (!right) return truncateToWidth(left, width, "");
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "");
  const leftWidth = Math.max(0, width - rightWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth, "");
  return `${fittedLeft}${" ".repeat(width - visibleWidth(fittedLeft) - rightWidth)}${right}`;
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
      const insertBindings = {
        ...keybindings.getUserBindings(),
        "tui.altScreen.halfPageUp": [],
        "tui.altScreen.halfPageDown": [],
      };
      const normalBindings = {
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

          const stats: string[] = [];
          if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
          if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
          if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
          if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
          if (totals.cost) stats.push(`$${totals.cost.toFixed(3)}`);

          const context = ctx.getContextUsage();
          const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercent = context?.percent;
          const contextLabel = `${contextPercent === null || contextPercent === undefined ? "?" : contextPercent.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
          const styledContext =
            (contextPercent ?? 0) > 90
              ? theme.fg("error", contextLabel)
              : (contextPercent ?? 0) > 70
                ? theme.fg("warning", contextLabel)
                : contextLabel;
          stats.push(styledContext);
          const statsLine = theme.fg("dim", stats.join(" "));

          const modelName = ctx.model?.id ?? "no-model";
          const modelLabel = ctx.model?.reasoning
            ? `${modelName} · ${ctx.thinkingLevel ?? "off"}`
            : modelName;
          const model = theme.fg("accent", theme.bold(modelLabel));

          const extensionStatus = otherStatuses.length
            ? theme.fg("muted", ` ${otherStatuses.join(" ")}`)
            : "";
          const vimStatus = `${modeChip(theme, mode, branch)}${extensionStatus}`;

          return [alignSides(statsLine, model, width), truncateToWidth(vimStatus, width, "")];
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
      "pi-vim-context",
      () => ({
        render(width: number): string[] {
          const theme = ctx.ui.theme;
          const directory = theme.fg("dim", formatDirectory(ctx.sessionManager.getCwd()));
          const netns = footerDataRef?.getExtensionStatuses().get("netns");
          const namespace = netns ? theme.fg("dim", `  ${sanitizeStatus(netns)}`) : "";
          return [truncateToWidth(`${directory}${namespace}`, width, "")];
        },
        invalidate() {},
      }),
      { placement: "aboveEditor" },
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    restoreBindings?.();
    restoreBindings = undefined;
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("pi-vim-context", undefined);
    ctx.ui.setFooter(undefined);
    if (activeFactory && ctx.ui.getEditorComponent() === activeFactory) {
      ctx.ui.setEditorComponent(previousFactory);
    }
    activeFactory = undefined;
    previousFactory = undefined;
  });
}
