import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, ScrollView, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyTodoAction,
  EMPTY_TODOS,
  parseTodoItem,
  parseTodoPlan,
  parseTodoSnapshot,
  restoreTodos,
  TODO_ENTRY,
  todoText,
  type TodoSnapshot,
} from "./model.ts";
import { withTodoMemory } from "./memory.ts";
import { renderTodoList } from "./view.ts";
import { registerOutcome } from "./outcome-tool.ts";

const identity = {
  id: Type.Integer({ minimum: 1 }),
  text: Type.String({ minLength: 1 }),
  notes: Type.Optional(Type.String({ minLength: 1 })),
};
const itemSchema = Type.Union([
  Type.Object({
    ...identity,
    status: Type.Union([Type.Literal("pending"), Type.Literal("doing"), Type.Literal("done")]),
  }),
  Type.Object({
    ...identity,
    status: Type.Union([Type.Literal("blocked"), Type.Literal("skipped")]),
    reason: Type.String({ minLength: 1 }),
  }),
]);
const planSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  items: Type.Array(itemSchema),
});
const snapshotSchema = Type.Object({
  version: Type.Literal(1),
  visibility: Type.Union([Type.Literal("shown"), Type.Literal("hidden")]),
  plan: Type.Union([planSchema, Type.Null()]),
});

export default function todosExtension(pi: ExtensionAPI) {
  registerOutcome(pi);
  let snapshot: TodoSnapshot = EMPTY_TODOS;

  const restore = (ctx: ExtensionContext) => {
    snapshot = EMPTY_TODOS;
    try {
      snapshot = restoreTodos(ctx.sessionManager.getBranch());
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      else throw error;
    }
    if (ctx.mode === "tui") ctx.ui.setWidget(TODO_ENTRY, undefined);
  };

  const persist = (next: TodoSnapshot) => {
    pi.appendEntry(TODO_ENTRY, next);
    snapshot = next;
  };

  pi.on("context", (event, ctx) => ({
    messages: withTodoMemory(event.messages, restoreTodos(ctx.sessionManager.getBranch())),
  }));
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName === "codemode") restore(ctx);
  });

  pi.registerTool({
    name: "todo",
    label: "Todos",
    description:
      "Manage the current task's visible, branch-aware todo plan. replace creates the full plan; update replaces one item by its stable positive id; list reads it; clear removes it. Preserve unchanged steps, use pending/doing/done/blocked/skipped, and give a reason for blocked or skipped steps. Persisted state survives codemode, reload, resume, and branch navigation. This tool does not authorize work or enqueue agent turns.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("replace"),
        Type.Literal("update"),
        Type.Literal("list"),
        Type.Literal("clear"),
      ]),
      plan: Type.Optional(planSchema),
      item: Type.Optional(itemSchema),
    }),
    outputSchema: snapshotSchema,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const current = restoreTodos(ctx.sessionManager.getBranch());
      switch (params.action) {
        case "replace":
          persist(
            applyTodoAction(current, { action: "replace", plan: parseTodoPlan(params.plan) }),
          );
          break;
        case "update":
          persist(applyTodoAction(current, { action: "update", item: parseTodoItem(params.item) }));
          break;
        case "clear":
          persist(applyTodoAction(current, { action: "clear" }));
          break;
        case "list":
          snapshot = current;
          break;
        default: {
          const exhaustive: never = params.action;
          throw new Error(`Unknown todo command ${exhaustive}`);
        }
      }
      return {
        content: [{ type: "text", text: todoText(snapshot) }],
        details: snapshot,
        structuredContent: snapshot,
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action ?? "");
      if (args.item?.id !== undefined) text += " " + theme.fg("accent", `#${args.item.id}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const text = result.content.find((part) => part.type === "text");
      if (context.isError)
        return new Text(
          theme.fg("error", text?.type === "text" ? text.text : "Todo operation failed"),
          0,
          0,
        );
      return renderTodoList(parseTodoSnapshot(result.details), expanded, theme);
    },
  });

  pi.registerCommand("todos", {
    description: "Show the full todo checklist",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/todos requires interactive mode", "error");
        return;
      }
      const current = restoreTodos(ctx.sessionManager.getBranch());
      switch (args.trim()) {
        case "hide":
          persist(applyTodoAction(current, { action: "visibility", visibility: "hidden" }));
          ctx.ui.setWidget(TODO_ENTRY, undefined);
          break;
        case "":
        case "show":
        case "list":
          if (args.trim() === "show")
            persist(applyTodoAction(current, { action: "visibility", visibility: "shown" }));
          await ctx.ui.custom<void>(
            (tui, theme, _keys, done) => {
              const view = new ScrollView(renderTodoList(current, true, theme), {
                overscroll: "contain",
              });
              const hint = new Text(
                theme.fg("dim", "Esc closes · j/k / ↑↓ scroll · PgUp/PgDn page"),
                0,
                1,
              );
              return {
                render: (width: number) => {
                  const lines = view.render(width);
                  const footer = hint.render(width);
                  const height = Math.max(1, tui.terminal.rows - footer.length - 6);
                  const border = theme.fg("borderMuted", "─".repeat(width));
                  view.updateLayout(lines.length, height, () => tui.requestRender());
                  return [
                    border,
                    ...lines.slice(view.scrollTop, view.scrollTop + height),
                    ...footer,
                    border,
                  ];
                },
                invalidate: () => {
                  view.invalidate();
                  hint.invalidate();
                },
                handleInput: (data: string) => {
                  if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done();
                  else if (matchesKey(data, "up") || matchesKey(data, "k")) {
                    view.scrollBy(-1);
                    tui.requestRender();
                  } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
                    view.scrollBy(1);
                    tui.requestRender();
                  } else if (matchesKey(data, Key.pageUp)) {
                    view.scrollBy(-Math.max(1, view.viewportHeight - 1));
                    tui.requestRender();
                  } else if (matchesKey(data, Key.pageDown)) {
                    view.scrollBy(Math.max(1, view.viewportHeight - 1));
                    tui.requestRender();
                  }
                },
              };
            },
            { overlay: true, overlayOptions: { width: "100%" } },
          );
          break;
        default:
          ctx.ui.notify("Usage: /todos [list|show|hide]", "warning");
      }
    },
  });
}
