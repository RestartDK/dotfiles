import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { terminalText, type TodoItem, type TodoSnapshot } from "./model.ts";

const appearances = {
  pending: { symbol: "○", color: "dim", priority: 2 },
  doing: { symbol: "→", color: "accent", priority: 0 },
  done: { symbol: "✓", color: "success", priority: 4 },
  blocked: { symbol: "!", color: "warning", priority: 1 },
  skipped: { symbol: "↷", color: "dim", priority: 3 },
} satisfies Record<
  TodoItem["status"],
  { symbol: string; color: Parameters<Theme["fg"]>[0]; priority: number }
>;

export function renderTodoList(snapshot: TodoSnapshot, expanded: boolean, theme: Theme): Text {
  const plan = snapshot.plan;
  if (!plan) return new Text(theme.fg("dim", "No saved todos."), 0, 0);

  const done = plan.items.filter((item) => item.status === "done").length;
  const skipped = plan.items.filter((item) => item.status === "skipped").length;
  const lines = [
    theme.fg("accent", theme.bold(terminalText(plan.title))),
    theme.fg(
      "muted",
      `${done}/${plan.items.length} completed${skipped ? ` · ${skipped} skipped` : ""}`,
    ),
    "",
  ];
  const shown = expanded
    ? plan.items
    : [...plan.items]
        .sort(
          (left, right) => appearances[left.status].priority - appearances[right.status].priority,
        )
        .slice(0, 5);
  if (plan.items.length === 0) lines.push(theme.fg("dim", "No items in this checklist."));
  for (const item of shown) {
    const { symbol, color } = appearances[item.status];
    const textColor = item.status === "done" || item.status === "skipped" ? "dim" : "text";
    lines.push(
      `${theme.fg(color, symbol)} ${theme.fg("accent", `#${item.id}`)} ${theme.fg(textColor, terminalText(item.text))}`,
    );
    if ("reason" in item)
      lines.push(theme.fg(color, `  ${item.status}: ${terminalText(item.reason)}`));
    if (expanded && item.notes) lines.push(theme.fg("muted", `  ${terminalText(item.notes)}`));
  }
  if (!expanded && shown.length < plan.items.length)
    lines.push(theme.fg("dim", `… ${plan.items.length - shown.length} more · /todos to view all`));
  return new Text(lines.join("\n"), 0, 0);
}
