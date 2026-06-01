import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

type SearchItem = {
  id: string;
  role: string;
  timestamp: string;
  text: string;
  haystack: string;
};

type ThemeLike = {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part: any) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text ?? "";
      if (part.type === "thinking") return part.thinking ? `[thinking] ${part.thinking}` : "";
      if (part.type === "toolCall") {
        return `[tool call: ${part.name ?? "unknown"}] ${JSON.stringify(part.arguments ?? {})}`;
      }
      if (part.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function entryToSearchItem(entry: any): SearchItem | null {
  const id = entry.id ?? "????????";
  const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "";

  if (entry.type === "message" && entry.message) {
    const message = entry.message;
    let role = message.role ?? "message";
    let text = "";

    if (message.role === "bashExecution") {
      role = "bash";
      text = `$ ${message.command ?? ""}\n${message.output ?? ""}`;
    } else if (message.role === "toolResult") {
      role = `tool:${message.toolName ?? "result"}`;
      text = contentToText(message.content);
    } else if (message.role === "custom") {
      role = `custom:${message.customType ?? "message"}`;
      text = contentToText(message.content);
    } else {
      text = contentToText(message.content);
    }

    text = text.trim();
    if (!text) return null;
    return { id, role, timestamp, text, haystack: `${role} ${timestamp} ${id} ${text}` };
  }

  if (entry.type === "compaction") {
    const text = String(entry.summary ?? "").trim();
    if (!text) return null;
    return { id, role: "compaction", timestamp, text, haystack: `compaction ${timestamp} ${id} ${text}` };
  }

  if (entry.type === "branch_summary") {
    const text = String(entry.summary ?? "").trim();
    if (!text) return null;
    return { id, role: "branch", timestamp, text, haystack: `branch ${timestamp} ${id} ${text}` };
  }

  if (entry.type === "custom_message") {
    const text = contentToText(entry.content).trim();
    if (!text) return null;
    const role = `custom:${entry.customType ?? "message"}`;
    return { id, role, timestamp, text, haystack: `${role} ${timestamp} ${id} ${text}` };
  }

  return null;
}

function buildItems(ctx: any): SearchItem[] {
  return ctx.sessionManager
    .getBranch()
    .map(entryToSearchItem)
    .filter((item: SearchItem | null): item is SearchItem => item !== null)
    .reverse();
}

class SessionSearchOverlay implements Component, Focusable {
  private query: string;
  private cursor = 0;
  private selected = 0;
  private resultOffset = 0;
  private previewOffset = 0;
  private lastResultHeight = 10;
  private layout = { resultTop: 0, resultBottom: 0, previewTop: 0, previewBottom: 0 };
  private results: SearchItem[];
  private fzf: { find: (query: string) => Array<{ item: SearchItem }> };
  private focusedValue = false;

  constructor(
    private readonly tui: any,
    private readonly items: SearchItem[],
    initialQuery: string,
    private readonly theme: ThemeLike,
    private readonly done: (result: SearchItem | null) => void,
    FzfCtor: new (items: SearchItem[], options: { selector: (item: SearchItem) => string }) => { find: (query: string) => Array<{ item: SearchItem }> },
  ) {
    this.query = initialQuery;
    this.cursor = initialQuery.length;
    this.fzf = new FzfCtor(items, { selector: (item) => item.haystack });
    this.results = this.find();
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
  }

  handleInput(data: string): void {
    if (this.handleMouse(data)) return;

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(null);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(this.results[this.selected] ?? null);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("j"))) {
      this.scrollResults(1);
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("k"))) {
      this.scrollResults(-1);
      return;
    }
    if (matchesKey(data, Key.ctrl("d")) || matchesKey(data, Key.pageDown)) {
      this.scrollPreview(5);
      return;
    }
    if (matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.pageUp)) {
      this.scrollPreview(-5);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.cursor = Math.min(this.query.length, this.cursor + 1);
      return;
    }
    if (matchesKey(data, Key.home) || matchesKey(data, Key.ctrl("a"))) {
      this.cursor = 0;
      return;
    }
    if (matchesKey(data, Key.end) || matchesKey(data, Key.ctrl("e"))) {
      this.cursor = this.query.length;
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.cursor > 0) {
        this.query = this.query.slice(0, this.cursor - 1) + this.query.slice(this.cursor);
        this.cursor--;
        this.refresh();
      }
      return;
    }
    if (matchesKey(data, Key.delete)) {
      if (this.cursor < this.query.length) {
        this.query = this.query.slice(0, this.cursor) + this.query.slice(this.cursor + 1);
        this.refresh();
      }
      return;
    }

    if (data.length > 0 && !data.startsWith("\x1b")) {
      this.query = this.query.slice(0, this.cursor) + data + this.query.slice(this.cursor);
      this.cursor += data.length;
      this.refresh();
    }
  }

  render(width: number): string[] {
    const termHeight = Math.max(1, this.tui?.terminal?.rows ?? 34);
    const modalWidth = Math.max(60, Math.min(width - 2, Math.floor(width * 0.9)));
    const leftPad = Math.max(0, Math.floor((width - modalWidth) / 2));
    const rightPad = Math.max(0, width - modalWidth - leftPad);
    const innerWidth = Math.max(20, modalWidth - 4);
    const selectedItem = this.results[this.selected];
    const lines: string[] = [];
    // Keep the whole search UI within the viewport so the terminal itself never scrolls.
    // Only these two panes have scrollable content.
    const fixedRows = 6; // top border, preview divider, search divider, input row, help row, bottom border
    const paneRows = Math.max(2, termHeight - fixedRows);
    const resultHeight = Math.max(1, Math.min(10, Math.ceil(paneRows * 0.55)));
    const previewHeight = Math.max(1, paneRows - resultHeight);

    const border = (label: string, color: string) => {
      const title = ` ${label} `;
      const left = Math.max(1, Math.floor((modalWidth - title.length) / 2));
      const right = Math.max(1, modalWidth - title.length - left);
      return truncateToWidth(this.theme.fg(color, `╭${"─".repeat(left - 1)}${title}${"─".repeat(right - 1)}╮`), modalWidth);
    };
    const divider = (label: string, color: string) => {
      const title = ` ${label} `;
      const left = Math.max(1, Math.floor((modalWidth - title.length) / 2));
      const right = Math.max(1, modalWidth - title.length - left);
      return truncateToWidth(this.theme.fg(color, `├${"─".repeat(left - 1)}${title}${"─".repeat(right - 1)}┤`), modalWidth);
    };
    const bottom = (color: string) => truncateToWidth(this.theme.fg(color, `╰${"─".repeat(Math.max(0, modalWidth - 2))}╯`), modalWidth);
    const row = (text: string, color = "border") => {
      const inner = Math.max(0, modalWidth - 2);
      const clipped = truncateToWidth(text, inner, "");
      const padding = Math.max(0, inner - visibleWidth(clipped));
      return truncateToWidth(this.theme.fg(color, "│") + clipped + " ".repeat(padding) + this.theme.fg(color, "│"), modalWidth);
    };
    const widthOf = (text: string) => visibleWidth(text.replace(/\x1b_pi:c\x07/g, ""));
    const rowRight = (left: string, right: string, color = "border") => {
      const inner = Math.max(0, modalWidth - 2);
      const rightWidth = widthOf(right);
      const leftText = truncateToWidth(left, Math.max(0, inner - rightWidth - 1), "");
      const spaces = Math.max(1, inner - widthOf(leftText) - rightWidth);
      return row(leftText + " ".repeat(spaces) + right, color);
    };

    const highlight = (text: string) => {
      const terms = this.query.trim().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return text;
      let out = text;
      for (const term of terms) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!escaped) continue;
        out = out.replace(new RegExp(escaped, "gi"), (match) => `\x1b[34m${match}\x1b[0m`);
      }
      return out;
    };

    lines.push(border("Results", "accent"));

    this.lastResultHeight = resultHeight;
    this.ensureResultVisible(resultHeight);
    const start = this.resultOffset;
    const visible = this.results.slice(start, start + resultHeight);
    for (let i = 0; i < resultHeight; i++) {
      if (visible.length === 0 && i === 0) {
        lines.push(row(this.theme.fg("warning", "  No matches"), "accent"));
        continue;
      }
      const item = visible[i];
      if (!item) {
        lines.push(row("", "accent"));
        continue;
      }
      const absoluteIndex = start + i;
        const selected = absoluteIndex === this.selected;
        const prefix = selected ? this.theme.fg("accent", "▸ ") : "  ";
        const role = selected ? this.theme.fg("accent", item.role) : this.theme.fg("muted", item.role);
        const preview = highlight(item.text.replace(/\s+/g, " "));
      const line = `${prefix}${role} ${this.theme.fg("dim", item.id)}  ${preview}`;
      lines.push(row(line, "accent"));
    }

    const allPreviewLines = selectedItem ? wrapTextWithAnsi(highlight(selectedItem.text), innerWidth) : [];
    this.previewOffset = Math.min(this.previewOffset, Math.max(0, allPreviewLines.length - previewHeight));
    const previewEnd = Math.min(allPreviewLines.length, this.previewOffset + previewHeight);
    const previewLabel = selectedItem
      ? `Preview ${selectedItem.role} ${selectedItem.id} ${allPreviewLines.length ? `${this.previewOffset + 1}-${previewEnd}/${allPreviewLines.length}` : ""}`
      : "Preview";
    lines.push(divider(previewLabel, "success"));
    const previewLines = allPreviewLines.slice(this.previewOffset, this.previewOffset + previewHeight);
    for (let i = 0; i < previewHeight; i++) {
      lines.push(row(previewLines[i] ? ` ${previewLines[i]}` : "", "success"));
    }

    lines.push(divider("Session Search", "warning"));
    const before = this.query.slice(0, this.cursor);
    const at = this.query[this.cursor] ?? " ";
    const after = this.query.slice(this.cursor + (this.query[this.cursor] ? 1 : 0));
    const count = this.theme.fg("dim", `${this.results.length} / ${this.items.length}`);
    const prompt = `${this.theme.fg("accent", "> ")}${before}${this.focused ? CURSOR_MARKER : ""}${this.theme.bg("selectedBg", at)}${after}`;
    lines.push(rowRight(prompt, count, "warning"));
    lines.push(row(this.theme.fg("dim", " ↑/↓ results • mouse wheel over panes • Ctrl-u/d preview • Enter jump • Esc close"), "warning"));
    lines.push(bottom("warning"));

    const modalLines = lines.map((line) => `${" ".repeat(leftPad)}${line}${" ".repeat(rightPad)}`);
    const topPad = Math.max(0, Math.floor((termHeight - modalLines.length) / 2));
    const bottomPad = Math.max(0, termHeight - modalLines.length - topPad);
    this.layout = {
      resultTop: topPad + 2,
      resultBottom: topPad + 1 + resultHeight,
      previewTop: topPad + 3 + resultHeight,
      previewBottom: topPad + 2 + resultHeight + previewHeight,
    };
    return [
      ...Array.from({ length: topPad }, () => " ".repeat(width)),
      ...modalLines.map((line) => truncateToWidth(line, width, "").padEnd(width)),
      ...Array.from({ length: bottomPad }, () => " ".repeat(width)),
    ];
  }

  invalidate(): void {}

  private refresh(): void {
    this.results = this.find();
    this.selected = 0;
    this.resultOffset = 0;
    this.previewOffset = 0;
  }

  private handleMouse(data: string): boolean {
    const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])$/);
    if (!match) return false;

    const button = Number(match[1]);
    const y = Number(match[3]);
    if (button !== 64 && button !== 65) return true;

    const delta = button === 64 ? -1 : 1;
    if (y >= this.layout.previewTop && y <= this.layout.previewBottom) {
      this.scrollPreview(delta * 3);
    } else if (y >= this.layout.resultTop && y <= this.layout.resultBottom) {
      this.scrollResults(delta * 3);
    }
    return true;
  }

  private scrollResults(delta: number): void {
    if (this.results.length === 0) return;
    this.selected = Math.max(0, Math.min(this.results.length - 1, this.selected + delta));
    this.previewOffset = 0;
    this.ensureResultVisible(this.lastResultHeight);
  }

  private ensureResultVisible(height: number): void {
    const maxOffset = Math.max(0, this.results.length - height);
    if (this.selected < this.resultOffset) this.resultOffset = this.selected;
    if (this.selected >= this.resultOffset + height) this.resultOffset = this.selected - height + 1;
    this.resultOffset = Math.max(0, Math.min(maxOffset, this.resultOffset));
  }

  private scrollPreview(delta: number): void {
    this.previewOffset = Math.max(0, this.previewOffset + delta);
  }

  private find(): SearchItem[] {
    const q = this.query.trim();
    if (!q) return this.items;
    return this.fzf.find(q).map((result) => result.item);
  }
}

class CurrentSessionViewport implements Component {
  private scrollOffset = 0;
  private initializedKey = "";
  private chatHeight = 1;

  constructor(
    private readonly tui: any,
    private readonly rootChildren: Component[],
    private readonly items: SearchItem[],
    private readonly selected: SearchItem,
    private readonly theme: ThemeLike,
  ) {}

  scroll(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
  }

  render(width: number): string[] {
    const termHeight = Math.max(1, this.tui?.terminal?.rows ?? 34);
    const chat = this.rootChildren[0];
    const lowerChildren = this.rootChildren.slice(1);
    const chatLines = chat ? chat.render(width) : [];
    const lowerLines = lowerChildren.flatMap((child) => child.render(width));
    this.chatHeight = Math.max(1, termHeight - lowerLines.length);
    const key = `${width}:${chatLines.length}:${this.selected.id}`;
    const maxOffset = Math.max(0, chatLines.length - this.chatHeight);

    if (this.initializedKey !== key) {
      this.initializedKey = key;
      const targetLine = this.findSelectedLine(chatLines);
      this.scrollOffset = Math.max(0, Math.min(maxOffset, targetLine - Math.floor(this.chatHeight / 3)));
    }

    this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset));
    const visibleChat = chatLines.slice(this.scrollOffset, this.scrollOffset + this.chatHeight);
    while (visibleChat.length < this.chatHeight) visibleChat.push("");

    if (visibleChat.length > 0) {
      const help = this.theme.bg(
        "selectedBg",
        this.theme.fg("dim", ` search jump: ${this.selected.role} ${this.selected.id} • mouse/PageUp/PageDown scroll • Esc/Ctrl-G bottom `),
      );
      const clipped = truncateToWidth(help, width, "");
      visibleChat[visibleChat.length - 1] = clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
    }

    return [...visibleChat, ...lowerLines].slice(0, termHeight).map((line) => truncateToWidth(line, width, "").padEnd(width));
  }

  invalidate(): void {
    for (const child of this.rootChildren) child.invalidate?.();
  }

  private findSelectedLine(lines: string[]): number {
    const plainLines = lines.map((line) => this.normalize(line));
    const candidates = this.getSearchCandidates();

    for (const candidate of candidates) {
      const index = plainLines.findIndex((line) => line.includes(candidate));
      if (index !== -1) return index;
    }

    const itemIndex = Math.max(0, this.items.findIndex((item) => item.id === this.selected.id));
    return Math.floor((itemIndex / Math.max(1, this.items.length - 1)) * Math.max(0, lines.length - 1));
  }

  private getSearchCandidates(): string[] {
    const normalized = this.normalize(this.selected.text);
    const candidates = new Set<string>();
    for (const line of this.selected.text.split("\n")) {
      const candidate = this.normalize(line);
      if (candidate.length >= 8) candidates.add(candidate.slice(0, 80));
      if (candidate.length >= 24) candidates.add(candidate.slice(0, 40));
    }
    if (normalized.length >= 8) candidates.add(normalized.slice(0, 100));
    if (normalized.length >= 24) candidates.add(normalized.slice(0, 50));
    for (const word of normalized.split(" ").filter((word) => word.length >= 12).slice(0, 8)) candidates.add(word);
    return [...candidates].sort((a, b) => b.length - a.length);
  }

  private normalize(text: string): string {
    return text
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b_[^\x1b]*(?:\x1b\\|\x07)/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
}

let activeJumpCleanup: (() => void) | undefined;

async function showCurrentSessionAtSelection(ctx: any, selected: SearchItem, items: SearchItem[]): Promise<void> {
  activeJumpCleanup?.();
  activeJumpCleanup = undefined;

  await ctx.ui.custom<void>((tui: any, _theme: ThemeLike, _keybindings: unknown, done: () => void) => {
    const terminal = tui.terminal;
    const chat = tui.children[0] as Component & { render: (width: number) => string[] };
    if (!chat?.render) {
      done(undefined);
      return { render: () => [""], invalidate: () => {} };
    }

    const originalRender = chat.render.bind(chat);
    let active = true;
    let mouseMode = true;
    let scrollOffset = 0;
    let initializedKey = "";
    let visibleChatHeight = 1;

    const normalize = (text: string) =>
      text
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b_[^\x1b]*(?:\x1b\\|\x07)/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const searchCandidates = () => {
      const normalized = normalize(selected.text);
      const candidates = new Set<string>();
      for (const line of selected.text.split("\n")) {
        const candidate = normalize(line);
        if (candidate.length >= 8) candidates.add(candidate.slice(0, 80));
        if (candidate.length >= 24) candidates.add(candidate.slice(0, 40));
      }
      if (normalized.length >= 8) candidates.add(normalized.slice(0, 100));
      if (normalized.length >= 24) candidates.add(normalized.slice(0, 50));
      for (const word of normalized.split(" ").filter((word) => word.length >= 12).slice(0, 8)) candidates.add(word);
      return [...candidates].sort((a, b) => b.length - a.length);
    };

    const findSelectedLine = (lines: string[]) => {
      const plain = lines.map(normalize);
      for (const candidate of searchCandidates()) {
        const index = plain.findIndex((line) => line.includes(candidate));
        if (index !== -1) return index;
      }
      const itemIndex = Math.max(0, items.findIndex((item) => item.id === selected.id));
      return Math.floor((itemIndex / Math.max(1, items.length - 1)) * Math.max(0, lines.length - 1));
    };

    const scroll = (delta: number) => {
      scrollOffset = Math.max(0, scrollOffset + delta);
      tui.requestRender();
    };

    chat.render = (width: number) => {
      const allChatLines = originalRender(width);
      const otherLines = tui.children.filter((child: Component) => child !== chat).flatMap((child: Component) => child.render(width));
      visibleChatHeight = Math.max(1, (terminal?.rows ?? 24) - otherLines.length);
      const maxOffset = Math.max(0, allChatLines.length - visibleChatHeight);
      const key = `${width}:${allChatLines.length}:${selected.id}`;

      if (initializedKey !== key) {
        initializedKey = key;
        const targetLine = findSelectedLine(allChatLines);
        scrollOffset = Math.max(0, Math.min(maxOffset, targetLine - Math.floor(visibleChatHeight / 3)));
      }

      scrollOffset = Math.max(0, Math.min(maxOffset, scrollOffset));
      const visible = allChatLines.slice(scrollOffset, scrollOffset + visibleChatHeight);
      while (visible.length < visibleChatHeight) visible.push("");
      return visible;
    };

    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      if (!active) return;
      active = false;
      chat.render = originalRender;
      if (mouseMode) {
        mouseMode = false;
        terminal?.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
      }
      unsubscribe?.();
      if (activeJumpCleanup === cleanup) activeJumpCleanup = undefined;
      tui.requestRender(true);
    };

    unsubscribe = tui.addInputListener((data: string) => {
      if (!active) return undefined;
      const mouse = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])$/);
      if (mouse) {
        const button = Number(mouse[1]);
        if (button === 64 || button === 65) {
          scroll(button === 64 ? -3 : 3);
          return { consume: true };
        }
        return { consume: true };
      }
      if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
        scroll(Math.max(3, Math.floor(visibleChatHeight * 0.8)));
        return { consume: true };
      }
      if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
        scroll(-Math.max(3, Math.floor(visibleChatHeight * 0.8)));
        return { consume: true };
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("g"))) {
        cleanup();
        return { consume: true };
      }
      // Keep the user's existing input and normal editor behavior intact.
      // Non-scroll keys pass through to Pi's normal editor/input handling.
      return undefined;
    });

    activeJumpCleanup = cleanup;
    terminal?.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    tui.requestRender(true);

    // We only use ctx.ui.custom to get access to the live TUI instance. Close the
    // temporary custom UI immediately so focus stays on Pi's real editor.
    done(undefined);
    return {
      render: () => [""],
      invalidate: () => {},
      dispose: () => {},
    };
  }, {
    overlay: true,
    overlayOptions: { width: 1, maxHeight: 1, anchor: "top-left", margin: 0, nonCapturing: true },
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", () => {
    activeJumpCleanup?.();
    activeJumpCleanup = undefined;
  });

  pi.registerCommand("search", {
    description: "Fuzzy search current session messages with an fzf-style overlay",
    handler: async (args, ctx) => {
      activeJumpCleanup?.();
      activeJumpCleanup = undefined;

      const items = buildItems(ctx);
      if (items.length === 0) {
        ctx.ui.notify("No searchable session messages yet", "info");
        return;
      }

      const { Fzf } = await import("fzf");

      let activeTui: any;
      let activeTerminal: any;
      let alternateScreen = false;
      let mouseMode = false;

      const selected = await ctx.ui.custom<SearchItem | null>((tui, theme, _keybindings, done) => {
        activeTui = tui;
        activeTerminal = tui.terminal;
        const previousChildren = [...tui.children];
        let restored = false;
        const overlay = new SessionSearchOverlay(tui, items, args.trim(), theme as ThemeLike, done, Fzf);

        return {
          render: (width: number) => overlay.render(width),
          invalidate: () => overlay.invalidate(),
          handleInput: (data: string) => {
            overlay.handleInput(data);
            tui.requestRender();
          },
          dispose: () => {
            if (!restored) {
              restored = true;
              tui.children = previousChildren;
            }
            if (mouseMode) {
              mouseMode = false;
              activeTerminal?.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
            }
            if (alternateScreen) {
              alternateScreen = false;
              // Return to Pi's normal screen, then force Pi to redraw itself from scratch.
              activeTerminal?.write("\x1b[?1049l");
            }
            activeTui?.requestRender(true);
          },
          get focused() {
            return overlay.focused;
          },
          set focused(value: boolean) {
            overlay.focused = value;
          },
        };
      }, {
        overlay: true,
        overlayOptions: {
          width: "100%",
          maxHeight: "100%",
          anchor: "center",
          margin: 0,
        },
        onHandle: () => {
          if (alternateScreen) return;
          alternateScreen = true;
          // Enter alternate screen only after the overlay has been registered.
          // Also remove Pi's normal root children while search is active: otherwise
          // a full redraw would still print the whole chat above the overlay into
          // alternate-screen scrollback, which mouse-wheel scrolling can reveal.
          if (activeTui) activeTui.children = [];
          mouseMode = true;
          activeTerminal?.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[3J\x1b[?1000h\x1b[?1002h\x1b[?1006h");
          activeTui?.requestRender(true);
        },
      });

      if (selected) {
        await showCurrentSessionAtSelection(ctx, selected, items);
      }
    },
  });
}
