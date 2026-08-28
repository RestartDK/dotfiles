import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const SEGMENT_SEPARATOR = "";
const FOLDER_ICON = "\u{F115}";
const MODEL_COLOR = "#d787af";
const PATH_COLOR = "#00afaf";

export interface StatusLineInput {
  model: string;
  reasoning: boolean;
  thinkingLevel: string;
  cwd: string;
  contextPercent: number | null;
  contextWindow: number;
  cost: number;
  netns?: string;
}

const THINKING_COLORS: Record<string, ThemeColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

let cachedOsIcon: string | undefined;

function osIcon(): string {
  if (cachedOsIcon !== undefined) return cachedOsIcon;
  cachedOsIcon = detectOsIcon();
  return cachedOsIcon;
}

function detectOsIcon(): string {
  if (process.platform === "darwin") return "\u{F179}";
  if (process.platform === "win32") return "\u{F17A}";
  if (existsSync("/etc/os-release")) {
    const release = readFileSync("/etc/os-release", "utf8");
    if (/^ID="?nixos"?$/m.test(release)) return "\u{F313}";
  }
  return "\u{F17C}";
}

function hexFg(hex: string, text: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function buildLine(input: StatusLineInput, theme: Theme): string {
  const segments: string[] = [theme.fg("accent", osIcon())];

  let model = hexFg(MODEL_COLOR, input.model);
  if (input.reasoning && input.thinkingLevel !== "off") {
    const levelColor = THINKING_COLORS[input.thinkingLevel] ?? "dim";
    model += `${theme.fg("dim", " · ")}${theme.fg(levelColor, input.thinkingLevel)}`;
  }
  segments.push(model);

  segments.push(hexFg(PATH_COLOR, `${FOLDER_ICON} ${basename(resolve(input.cwd)) || input.cwd}`));

  const percent = input.contextPercent;
  const contextText = `${percent === null ? "?" : percent.toFixed(1)}%/${formatTokens(input.contextWindow)}`;
  const contextColor: ThemeColor =
    percent === null ? "dim" : percent > 90 ? "error" : percent > 70 ? "warning" : "dim";
  segments.push(theme.fg(contextColor, contextText));

  if (input.netns) {
    segments.push(theme.fg("accent", input.netns));
  }

  if (input.cost > 0) {
    segments.push(theme.fg("warning", `$${input.cost.toFixed(2)}`));
  }

  return ` ${segments.join(theme.fg("dim", ` ${SEGMENT_SEPARATOR} `))} `;
}

export function renderStatusLine(input: StatusLineInput, theme: Theme, width: number): string {
  const line = buildLine(input, theme);
  if (visibleWidth(line) <= width) return line;
  return truncateToWidth(line, width);
}
