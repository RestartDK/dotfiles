import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  ScrollView,
  Text,
  TruncatedText,
} from "@earendil-works/pi-tui";
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
  let snapshot: TodoSnapshot = EMPTY_TODOS;

  const render = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    if (snapshot.visibility === "hidden" || !snapshot.plan) {
      ctx.ui.setWidget(TODO_ENTRY, undefined);
      return;
    }
    ctx.ui.setWidget(TODO_ENTRY, (_tui, theme) => {
      const widget = new Container();
      for (const line of todoText(snapshot).split("\n"))
        widget.addChild(new TruncatedText(theme.fg("muted", line), 0, 0));
      return widget;
    });
  };

  const restore = (ctx: ExtensionContext) => {
    snapshot = EMPTY_TODOS;
    try {
      snapshot = restoreTodos(ctx.sessionManager.getBranch());
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      else throw error;
    }
    render(ctx);
  };

  const persist = (next: TodoSnapshot, ctx: ExtensionContext) => {
    pi.appendEntry(TODO_ENTRY, next);
    snapshot = next;
    render(ctx);
  };

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
            ctx,
          );
          break;
        case "update":
          persist(
            applyTodoAction(current, { action: "update", item: parseTodoItem(params.item) }),
            ctx,
          );
          break;
        case "clear":
          persist(applyTodoAction(current, { action: "clear" }), ctx);
          break;
        case "list":
          snapshot = current;
          render(ctx);
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
    renderResult(result, { expanded }, theme, context) {
      const text = result.content.find((part) => part.type === "text");
      if (context.isError)
        return new Text(
          theme.fg("error", text?.type === "text" ? text.text : "Todo operation failed"),
          0,
          0,
        );
      return new Text(
        theme.fg("muted", todoText(parseTodoSnapshot(result.details), expanded)),
        0,
        0,
      );
    },
  });

  pi.registerCommand("todos", {
    description: "Toggle the todo widget, or use show, hide, or list",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/todos requires interactive mode", "error");
        return;
      }
      const current = restoreTodos(ctx.sessionManager.getBranch());
      switch (args.trim()) {
        case "":
          persist(
            applyTodoAction(current, {
              action: "visibility",
              visibility: current.visibility === "shown" ? "hidden" : "shown",
            }),
            ctx,
          );
          break;
        case "show":
        case "hide":
          persist(
            applyTodoAction(current, {
              action: "visibility",
              visibility: args.trim() === "show" ? "shown" : "hidden",
            }),
            ctx,
          );
          break;
        case "list":
          await ctx.ui.custom<void>(
            (tui, _theme, _keys, done) => {
              const view = new ScrollView(
                new Text(todoText(current, true) + "\n\nEscape closes; arrows scroll", 1, 1),
                { scrollbar: "auto", overscroll: "contain" },
              );
              return Object.assign(view, {
                handleInput: (data: string) => {
                  if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done();
                  else if (matchesKey(data, "up")) {
                    view.scrollBy(-1);
                    tui.requestRender();
                  } else if (matchesKey(data, "down")) {
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
              });
            },
            { overlay: true },
          );
          break;
        default:
          ctx.ui.notify("Usage: /todos [show|hide|list]", "warning");
      }
    },
  });
}
