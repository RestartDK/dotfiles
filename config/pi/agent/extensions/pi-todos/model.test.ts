import { describe, expect, test } from "bun:test";
import {
  applyTodoAction,
  EMPTY_TODOS,
  parseTodoItem,
  parseTodoPlan,
  parseTodoSnapshot,
  restoreTodos,
  TODO_ENTRY,
  todoText,
  type TodoPlan,
} from "./model.ts";

const plan: TodoPlan = {
  title: "UI cleanup",
  items: [
    { id: 1, text: "Read principles", status: "done" },
    { id: 2, text: "Verify the real component", status: "doing" },
  ],
};
const native = (data: unknown) => ({ type: "custom", customType: TODO_ENTRY, data });
const legacy = (set: object, deleted: string[] = []) => ({
  type: "custom",
  customType: "codemode-store",
  data: { set, delete: deleted },
});

describe("todo boundary and state transitions", () => {
  test("blocked and skipped steps cannot lose their reason", () => {
    for (const status of ["blocked", "skipped"]) {
      expect(() => parseTodoItem({ id: 1, text: "Verify", status })).toThrow("requires a reason");
      expect(() => parseTodoItem({ id: 1, text: "Verify", status, reason: " " })).toThrow(
        "non-empty",
      );
    }
    expect(
      parseTodoItem({ id: 1, text: "Verify", status: "blocked", reason: "Missing runtime" }),
    ).toEqual({ id: 1, text: "Verify", status: "blocked", reason: "Missing runtime" });
  });

  test("malformed ids, empty text, duplicate ids and unknown states are rejected before mutation", () => {
    for (const id of [0, -1, 1.5, Number.NaN, "1"])
      expect(() => parseTodoItem({ id, text: "Step", status: "pending" })).toThrow();
    expect(() => parseTodoItem({ id: 1, text: " ", status: "pending" })).toThrow();
    expect(() => parseTodoItem({ id: 1, text: "Step", status: "finished-ish" })).toThrow("Unknown");
    expect(() => parseTodoPlan({ title: "Plan", items: [plan.items[0], plan.items[0]] })).toThrow(
      "unique",
    );
    expect(() => parseTodoSnapshot({ version: 2, visibility: "shown", plan })).toThrow(
      "Unsupported",
    );
  });

  test("repeated updates converge instead of toggling a completed item back", () => {
    const original = applyTodoAction(EMPTY_TODOS, { action: "replace", plan });
    const action = {
      action: "update",
      item: { id: 2, text: "Verify the real component", status: "done" },
    } as const;
    const updated = applyTodoAction(original, action);
    expect(applyTodoAction(updated, action)).toEqual(updated);
    expect(original.plan?.items[1].status).toBe("doing");
    expect(() =>
      applyTodoAction(original, {
        action: "update",
        item: { id: 99, text: "Other", status: "done" },
      }),
    ).toThrow("does not exist");
    expect(() => applyTodoAction(EMPTY_TODOS, action)).toThrow("Create");
  });

  test("resume restores the selected branch and widget visibility without other-session memory", () => {
    const full = applyTodoAction(EMPTY_TODOS, { action: "replace", plan });
    const hidden = applyTodoAction(full, { action: "visibility", visibility: "hidden" });
    expect(restoreTodos([native(full), native(hidden)])).toEqual(hidden);
    expect(restoreTodos([native(full)])).toEqual(full);
    expect(restoreTodos([])).toEqual(EMPTY_TODOS);
  });
});

describe("legacy codemode plans", () => {
  test("the user's existing step/status arrays remain visible without guessing prose as success", () => {
    const state = restoreTodos([
      legacy({
        videoCleanupTodos: [
          { step: "Read principles", status: "done" },
          { step: "Name the shape", status: "skip; no new structure" },
          { step: "Verify", status: "exact base content and focused checks" },
        ],
      }),
    ]);
    expect(state.plan?.items.map((item) => item.status)).toEqual(["done", "skipped", "pending"]);
    expect(state.plan?.items[2].notes).toBe("exact base content and focused checks");
  });

  test("updates and deletion of the selected legacy key take effect", () => {
    const first = legacy({ oldTodos: [{ step: "Old", status: "done" }] });
    const next = legacy({ newerTodos: [{ step: "New", status: "doing" }] });
    expect(restoreTodos([first, next]).plan?.title).toBe("newerTodos");
    expect(restoreTodos([first, next, legacy({}, ["newerTodos"])]).plan).toBeNull();
    expect(restoreTodos([next, legacy({ newerTodos: [] })]).plan).toBeNull();
  });

  test("a native clear cannot be resurrected by later generic storage updates", () => {
    const old = legacy({ oldTodos: [{ step: "Old", status: "done" }] });
    const cleared = applyTodoAction(EMPTY_TODOS, { action: "clear" });
    expect(restoreTodos([old, native(cleared), old])).toEqual(cleared);
  });

  test("unrelated values and malformed rows do not become a todo plan", () => {
    expect(
      restoreTodos([
        legacy({ task: [{ step: "Other", status: "done" }], notTodos: [{ text: "Wrong shape" }] }),
      ]),
    ).toEqual(EMPTY_TODOS);
  });
});

describe("terminal output", () => {
  test("skip is distinct from done and blocked reasons remain readable", () => {
    const state = {
      ...EMPTY_TODOS,
      plan: {
        title: "Proof",
        items: [
          { id: 1, text: "Check", status: "blocked", reason: "No preview" },
          { id: 2, text: "Architecture", status: "skipped", reason: "Known shape" },
        ],
      },
    } as const;
    const text = todoText(parseTodoSnapshot(state), true);
    expect(text).toContain("0/2 done, 1 skipped");
    expect(text).toContain("No preview");
    expect(text).toContain("Known shape");
  });

  test("Unicode is retained but fixture text cannot emit terminal control sequences", () => {
    const state = parseTodoSnapshot({
      ...EMPTY_TODOS,
      plan: {
        title: "王秀英 👩🏽‍💻 \u001b[2J",
        items: [{ id: 1, text: "Aleksandra Wiśniewska-Kowalczyk\nverify", status: "doing" }],
      },
    });
    const text = todoText(state);
    expect(text).toContain("王秀英 👩🏽‍💻");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("Kowalczyk verify");
  });
});
