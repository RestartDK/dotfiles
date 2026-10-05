export const TODO_ENTRY = "dstack-todos";
export type TodoProgress =
  | { status: "pending" | "doing" | "done" }
  | { status: "blocked" | "skipped"; reason: string };
export type TodoItem = { id: number; text: string; notes?: string } & TodoProgress;
export type TodoPlan = { title: string; items: TodoItem[] };
export type TodoSnapshot = {
  version: 1;
  visibility: "shown" | "hidden";
  plan: TodoPlan | null;
};
export type TodoAction =
  | { action: "replace"; plan: TodoPlan }
  | { action: "update"; item: TodoItem }
  | { action: "clear" }
  | { action: "visibility"; visibility: TodoSnapshot["visibility"] };
export type TodoEntry = { type: string; customType?: string; data?: unknown };

export const EMPTY_TODOS: TodoSnapshot = { version: 1, visibility: "shown", plan: null };

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${field} must be non-empty`);
  return value.trim();
}

export function parseTodoItem(value: unknown): TodoItem {
  if (typeof value !== "object" || value === null) throw new Error("Todo item must be an object");
  if (
    !("id" in value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1
  )
    throw new Error("Todo id must be a positive integer");
  if (!("text" in value) || !("status" in value))
    throw new Error("Todo text and status are required");
  const base = { id: value.id, text: nonEmpty(value.text, "Todo text") };
  const notes = "notes" in value ? { notes: nonEmpty(value.notes, "Todo notes") } : {};
  switch (value.status) {
    case "pending":
    case "doing":
    case "done":
      return { ...base, ...notes, status: value.status };
    case "blocked":
    case "skipped":
      if (!("reason" in value)) throw new Error(`${value.status} requires a reason`);
      return {
        ...base,
        ...notes,
        status: value.status,
        reason: nonEmpty(value.reason, "Todo reason"),
      };
    default:
      throw new Error("Unknown todo status");
  }
}

export function parseTodoPlan(value: unknown): TodoPlan {
  if (
    typeof value !== "object" ||
    value === null ||
    !("title" in value) ||
    !("items" in value) ||
    !Array.isArray(value.items)
  )
    throw new Error("Todo plan requires a title and items");
  const items = value.items.map(parseTodoItem);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new Error("Todo ids must be unique");
  return { title: nonEmpty(value.title, "Plan title"), items };
}

export function parseTodoSnapshot(value: unknown): TodoSnapshot {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1)
    throw new Error("Unsupported todo snapshot version");
  if (
    !("visibility" in value) ||
    (value.visibility !== "shown" && value.visibility !== "hidden") ||
    !("plan" in value)
  )
    throw new Error("Invalid todo snapshot");
  return {
    version: 1,
    visibility: value.visibility,
    plan: value.plan === null ? null : parseTodoPlan(value.plan),
  };
}

function legacyPlan(key: string, value: unknown): TodoPlan | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items: TodoItem[] = [];
  for (const [index, row] of value.entries()) {
    if (
      typeof row !== "object" ||
      row === null ||
      !("step" in row) ||
      typeof row.step !== "string" ||
      row.step.trim() === "" ||
      !("status" in row) ||
      typeof row.status !== "string"
    )
      return null;
    const base = { id: index + 1, text: row.step.trim() };
    const status = row.status.trim();
    switch (status) {
      case "done":
      case "pending":
      case "doing":
        items.push({ ...base, status });
        break;
      default:
        if (/^skip(?:ped)?\b/i.test(status))
          items.push({ ...base, status: "skipped", reason: status });
        else if (/^blocked\b/i.test(status))
          items.push({ ...base, status: "blocked", reason: status });
        else
          items.push({
            ...base,
            status: "pending",
            notes: status || "Legacy status was unspecified",
          });
    }
  }
  return { title: key, items };
}

export function restoreTodos(branch: readonly TodoEntry[]): TodoSnapshot {
  let snapshot = EMPTY_TODOS;
  let native = false;
  let legacy: { key: string; plan: TodoPlan } | null = null;
  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (entry.customType === TODO_ENTRY) {
      snapshot = parseTodoSnapshot(entry.data);
      native = true;
    } else if (
      !native &&
      entry.customType === "codemode-store" &&
      typeof entry.data === "object" &&
      entry.data !== null
    ) {
      if (
        "delete" in entry.data &&
        Array.isArray(entry.data.delete) &&
        legacy &&
        entry.data.delete.includes(legacy.key)
      )
        legacy = null;
      if (!("set" in entry.data) || typeof entry.data.set !== "object" || entry.data.set === null)
        continue;
      for (const [key, value] of Object.entries(entry.data.set)) {
        if (!/todos$/i.test(key)) continue;
        const plan = legacyPlan(key, value);
        if (plan) legacy = { key, plan };
        else if (legacy?.key === key) legacy = null;
      }
    }
  }
  return native ? snapshot : { ...EMPTY_TODOS, plan: legacy?.plan ?? null };
}

export function applyTodoAction(snapshot: TodoSnapshot, action: TodoAction): TodoSnapshot {
  switch (action.action) {
    case "replace":
      return { ...snapshot, plan: action.plan };
    case "clear":
      return { ...snapshot, plan: null };
    case "visibility":
      return { ...snapshot, visibility: action.visibility };
    case "update": {
      if (!snapshot.plan) throw new Error("Create a todo plan before updating an item");
      if (!snapshot.plan.items.some((item) => item.id === action.item.id))
        throw new Error(`Todo #${action.item.id} does not exist`);
      return {
        ...snapshot,
        plan: {
          ...snapshot.plan,
          items: snapshot.plan.items.map((item) =>
            item.id === action.item.id ? action.item : item,
          ),
        },
      };
    }
    default: {
      const exhaustive: never = action;
      throw new Error(`Unknown todo action ${exhaustive}`);
    }
  }
}

function terminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function todoText(snapshot: TodoSnapshot, expanded = false): string {
  const plan = snapshot.plan;
  if (!plan) return "No todos. Ask the agent to create a plan with the todo tool.";
  const done = plan.items.filter((item) => item.status === "done").length;
  const skipped = plan.items.filter((item) => item.status === "skipped").length;
  const header = `Todos ${done}/${plan.items.length} done${skipped ? `, ${skipped} skipped` : ""} · ${terminalText(plan.title)}`;
  const remaining = plan.items.filter((item) => item.status !== "done");
  const priority = { doing: 0, blocked: 1, pending: 2, skipped: 3, done: 4 };
  const shown = expanded
    ? plan.items
    : [...remaining]
        .sort((left, right) => priority[left.status] - priority[right.status])
        .slice(0, 3);
  const lines = shown.map((item) => {
    const symbol = { pending: "○", doing: "→", done: "✓", blocked: "!", skipped: "↷" }[item.status];
    const reason = "reason" in item ? ` (${terminalText(item.reason)})` : "";
    const notes = expanded && item.notes ? ` · ${terminalText(item.notes)}` : "";
    return `${symbol} #${item.id} ${terminalText(item.text)}${reason}${notes}`;
  });
  if (!expanded && shown.length < plan.items.filter((item) => item.status !== "done").length)
    lines.push("/todos list shows every step");
  return [header, ...lines].join("\n");
}
