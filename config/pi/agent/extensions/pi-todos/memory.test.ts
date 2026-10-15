import { expect, test } from "bun:test";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { EMPTY_TODOS, TODO_ENTRY, restoreTodos, type TodoPlan } from "./model.ts";
import { TODO_MEMORY, todoReference, withTodoMemory } from "./memory.ts";

const plan: TodoPlan = {
  title: "A long saved plan",
  items: Array.from({ length: 35 }, (_, index) => ({
    id: index * 3 + 1,
    text: `Step ${index}`,
    status: "pending",
    notes: `Complete notes ${index}\nsecond line`,
  })),
};
plan.items[1] = { id: 4, text: "Current step", status: "doing", notes: "Full detail\n日本語 Åäö" };
plan.items[4] = {
  id: 13,
  text: "Waiting",
  status: "blocked",
  reason: "Need the user's answer",
  notes: "Preserve this detail",
};
plan.items[15] = { id: 46, text: "Not requested", status: "skipped", reason: "Outside scope" };
plan.items[17] = {
  id: 52,
  text: "Saved done claim",
  status: "done",
  notes: "Not independently verified",
};

test("request memory retains every stable id, literal state, note and reason even when hidden", () => {
  const snapshot = { ...EMPTY_TODOS, visibility: "hidden", plan } satisfies typeof EMPTY_TODOS;
  const reference = todoReference(snapshot);
  const data: unknown = JSON.parse(reference.slice(reference.indexOf("\n") + 1));
  expect(data).toEqual(plan);
  expect(withTodoMemory([], snapshot)).toHaveLength(1);
});

test("replacement is idempotent and preserves system, user, results and unrelated custom data in order", () => {
  const original: ContextEvent["messages"] = [
    { role: "system", content: "System authority", timestamp: 1 },
    { role: "user", content: "Current request", timestamp: 2 },
    {
      role: "toolResult",
      toolCallId: "existing",
      toolName: "todo",
      content: [],
      isError: false,
      timestamp: 3,
    },
    {
      role: "custom",
      customType: "unrelated",
      content: "Other reference",
      details: { customType: TODO_MEMORY },
      display: false,
      timestamp: 4,
    },
  ];
  const once = withTodoMemory(original, { ...EMPTY_TODOS, plan });
  const twice = withTodoMemory(once, { ...EMPTY_TODOS, plan });
  expect(twice).toEqual(once);
  expect(twice.slice(0, original.length)).toEqual(original);
  expect(original).toHaveLength(4);
  expect(
    twice.filter((message) => message.role === "custom" && message.customType === TODO_MEMORY),
  ).toHaveLength(1);
});

test("clear, old branch, legacy nested storage, and pre-compaction snapshots use the canonical store", () => {
  const old = {
    type: "custom",
    customType: "codemode-store",
    data: { set: { oldTodos: [{ step: "Legacy read", status: "doing" }] } },
  };
  const full = { type: "custom", customType: TODO_ENTRY, data: { ...EMPTY_TODOS, plan } };
  const cleared = { type: "custom", customType: TODO_ENTRY, data: EMPTY_TODOS };
  const priorMemory = withTodoMemory([], restoreTodos([old, full]));
  expect(todoReference(restoreTodos([old]))).toContain("Legacy read");
  expect(todoReference(restoreTodos([old, full, { type: "compaction" }]))).toContain(
    "Saved done claim",
  );
  const result = withTodoMemory(priorMemory, restoreTodos([old, full, cleared]));
  expect(result).toHaveLength(1);
  const message = result[0];
  if (message?.role !== "custom") throw new Error("Expected request-local reference");
  expect(message.content).toBe(todoReference(EMPTY_TODOS));
  expect(message.content).not.toContain("Legacy read");
});
