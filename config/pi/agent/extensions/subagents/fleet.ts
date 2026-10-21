import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PiActivity } from "./protocol";

export type FleetStatus = "running" | "completed" | "failed" | "stopped";

export interface FleetRun {
  id: string;
  title: string;
  model?: string;
  activity?: PiActivity;
  status: FleetStatus;
  startedAt: number;
  finishedAt?: number;
}

const states = {
  running: { label: "running", icon: "●", color: "accent" },
  completed: { label: "done", icon: "✓", color: "success" },
  failed: { label: "failed", icon: "✕", color: "error" },
  stopped: { label: "stopped", icon: "■", color: "muted" },
} as const;
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function singleLine(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function modelLabel(model: string | undefined): string {
  if (!model) return "starting";
  const id = model.split("/").at(-1) ?? model;
  if (/deepseek/i.test(id)) return "DeepSeek";
  if (/fable/i.test(id)) return "Fable";
  if (/astra/i.test(id)) return "Astra";
  return singleLine(id);
}

function activityLabel(run: FleetRun): string {
  if (run.status !== "running" || !run.activity) return states[run.status].label;
  switch (run.activity) {
    case "tool_execution_start":
      return "tools";
    case "auto_retry_start":
      return "retry";
    case "compaction_start":
      return "compact";
    case "agent_settled":
      return "exiting";
    default:
      return "working";
  }
}

function elapsed(run: FleetRun, now: number): string {
  const seconds = Math.max(0, Math.floor(((run.finishedAt ?? now) - run.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function counts(runs: readonly FleetRun[], theme: Theme, compact: boolean): string {
  return (Object.keys(states) as FleetStatus[])
    .flatMap((status) => {
      const count = runs.filter((run) => run.status === status).length;
      if (!count) return [];
      const state = states[status];
      return [
        theme.fg(state.color, compact ? `${state.icon} ${count}` : `${count} ${state.label}`),
      ];
    })
    .join(theme.fg("dim", " · "));
}

export function fleetStatus(runs: readonly FleetRun[], theme: Theme): string | undefined {
  return runs.length ? `${theme.fg("muted", "agents")} ${counts(runs, theme, true)}` : undefined;
}

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function renderFleet(
  runs: readonly FleetRun[],
  width: number,
  theme: Theme,
  now = Date.now(),
): string[] {
  if (!runs.length || width < 4) return [];
  width = Math.min(width, 96);
  const border = (text: string) => theme.fg("borderMuted", text);
  const inner = width - 4;
  const row = (text: string) => `${border("│")} ${fit(text, inner)} ${border("│")}`;
  const title = `${theme.fg("accent", theme.bold("Subagents"))} ${theme.fg("dim", "·")} ${counts(runs, theme, false)}`;
  const heading = truncateToWidth(` ${title} `, width - 2, "…");
  const lines = [
    border("╭") +
      heading +
      border("─".repeat(Math.max(0, width - 2 - visibleWidth(heading))) + "╮"),
  ];
  const priority: Record<FleetStatus, number> = { running: 0, failed: 1, stopped: 2, completed: 3 };
  const sorted = [...runs].sort(
    (a, b) => priority[a.status] - priority[b.status] || a.startedAt - b.startedAt,
  );
  for (const run of sorted.slice(0, 4)) {
    const state = states[run.status];
    const icon =
      run.status === "running" ? frames[Math.floor(now / 120) % frames.length]! : state.icon;
    const labelText = activityLabel(run);
    const status = theme.fg(state.color, labelText.padEnd(7));
    const time = theme.fg("dim", elapsed(run, now).padStart(7));
    const model = theme.fg(
      "muted",
      fit(
        run.model ? modelLabel(run.model) : run.status === "running" ? "starting" : "unavailable",
        12,
      ),
    );
    const suffix =
      inner >= 64
        ? `  ${model}  ${status} ${time}`
        : inner >= 40
          ? `  ${status} ${time}`
          : `  ${theme.fg(state.color, labelText)}`;
    const titleWidth = Math.max(0, inner - 2 - visibleWidth(suffix));
    const label = fit(singleLine(run.title), titleWidth);
    lines.push(
      row(
        `${theme.fg(state.color, icon)} ${run.status === "completed" ? theme.fg("muted", label) : label}${suffix}`,
      ),
    );
  }
  const hidden = runs.length - 4;
  if (hidden > 0) lines.push(row(theme.fg("dim", `+${hidden} more · /subagents for details`)));
  if (runs.some((run) => run.status === "failed" || run.status === "stopped")) {
    lines.push(row(theme.fg("dim", "/subagents clear to dismiss finished runs")));
  }
  lines.push(border("╰" + "─".repeat(width - 2) + "╯"));
  return lines;
}
