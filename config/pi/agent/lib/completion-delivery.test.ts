import { expect, test } from "bun:test";
import {
  CompletionReceipts,
  completionOrigin,
  type CompletionDelivery,
  type CompletionReceipt,
} from "./completion-delivery.ts";

type Branch = Parameters<CompletionReceipts["restore"]>[0];
const origin = { sessionId: "session-one", userEntryId: "request-one" };
const herdr = {
  kind: "herdr",
  paneId: "pane-one",
  runId: "run-one",
  outcome: "done",
} satisfies CompletionReceipt;
const coordinator = {
  kind: "coordination",
  id: "attempt-one",
  finishedAt: "2026-01-01T00:00:00Z",
  state: "settled",
  outcome: "completed",
} satisfies CompletionReceipt;

function message(details: unknown, toolName = "herdr"): Branch[number] {
  return {
    type: "message",
    id: "observed",
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    message: {
      role: "toolResult",
      toolCallId: "call-one",
      toolName,
      content: [],
      isError: false,
      timestamp: 0,
      details,
    },
  };
}

test("one completion wakes once even if multiple observers publish it", () => {
  const receipts = new CompletionReceipts("herdr");
  const delivered: CompletionDelivery[] = [];
  const publish = (delivery: CompletionDelivery) => delivered.push(delivery);
  expect(receipts.deliver({ receipt: herdr, origin, current: origin, publish })).toBe("delivered");
  expect(receipts.deliver({ receipt: herdr, origin, current: origin, publish })).toBe("ignored");
  expect(delivered).toEqual(["wake"]);
});

test("a synchronously consumed result never creates another completion turn", () => {
  const receipts = new CompletionReceipts("herdr");
  receipts.consume(herdr);
  expect(
    receipts.deliver({
      receipt: herdr,
      origin,
      current: origin,
      publish: () => {
        throw new Error("Already consumed");
      },
    }),
  ).toBe("ignored");
});

test("a stale completion is recorded without waking a newer user request", () => {
  const receipts = new CompletionReceipts("herdr");
  const delivered: CompletionDelivery[] = [];
  receipts.deliver({
    receipt: herdr,
    origin,
    current: { ...origin, userEntryId: "request-two" },
    publish: (delivery) => delivered.push(delivery),
  });
  expect(delivered).toEqual(["record"]);
});

test("a completion cannot wake a different session", () => {
  const receipts = new CompletionReceipts("herdr");
  expect(
    receipts.deliver({
      receipt: herdr,
      origin,
      current: { ...origin, sessionId: "session-two" },
      publish: () => {
        throw new Error("Wrong owner");
      },
    }),
  ).toBe("ignored");
});

test("failed delivery leaves the result available instead of falsely consumed", () => {
  const receipts = new CompletionReceipts("herdr");
  expect(() =>
    receipts.deliver({
      receipt: herdr,
      origin,
      current: origin,
      publish: () => {
        throw new Error("Transport failed");
      },
    }),
  ).toThrow("Transport failed");
  expect(receipts.deliver({ receipt: herdr, origin, current: origin, publish: () => {} })).toBe(
    "delivered",
  );
});

test("a blocked outcome and an inspected final release are distinct results", () => {
  const receipts = new CompletionReceipts("coordination");
  const blocked = {
    ...coordinator,
    state: "blocked",
    outcome: "unknown",
  } satisfies CompletionReceipt;
  const released = {
    ...blocked,
    state: "settled",
    finishedAt: "2026-01-02T00:00:00Z",
  } satisfies CompletionReceipt;
  expect(receipts.consume(blocked)).toBe(true);
  expect(receipts.consume(blocked)).toBe(false);
  expect(receipts.consume(released)).toBe(true);
});

test("reload restores an observed synchronous Herdr result", () => {
  const receipts = new CompletionReceipts("herdr");
  receipts.restore([message({ ...herdr, state: "done" })]);
  expect(receipts.consume(herdr)).toBe(false);
});

test("reload restores a delivered coordinator result", () => {
  const receipts = new CompletionReceipts("coordination");
  receipts.restore([
    {
      type: "custom_message",
      id: "notice",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      customType: "coordination-result",
      content: "Done",
      display: true,
      details: { attempt: coordinator },
    },
  ]);
  expect(receipts.consume(coordinator)).toBe(false);
});

test("an expired observation does not consume a later terminal result", () => {
  const receipts = new CompletionReceipts("herdr");
  receipts.restore([
    {
      type: "custom_message",
      id: "expired",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      customType: "herdr-run-finished",
      content: "Stopped watching",
      display: true,
      details: { kind: "expired", paneId: herdr.paneId, runId: herdr.runId, elapsedMs: 21600000 },
    },
  ]);
  expect(receipts.consume(herdr)).toBe(true);
});

test("a status list consumes the exact retained results it displayed", () => {
  const receipts = new CompletionReceipts("coordination");
  receipts.restore([message({ leases: [], attempts: [coordinator] }, "coordinate")]);
  expect(receipts.consume(coordinator)).toBe(false);
});

test("a running observation is not a completion receipt", () => {
  const receipts = new CompletionReceipts("herdr");
  receipts.restore([message({ ...herdr, state: "running" })]);
  expect(receipts.consume(herdr)).toBe(true);
});

test("another branch's receipts do not hide work on the current branch", () => {
  const receipts = new CompletionReceipts("herdr");
  receipts.restore([message({ ...herdr, state: "done" })]);
  receipts.restore([]);
  expect(receipts.consume(herdr)).toBe(true);
});

test("legacy or malformed details cannot masquerade as consumed results", () => {
  const receipts = new CompletionReceipts("coordination");
  receipts.restore([message({ attempt: { id: coordinator.id, state: true } }, "coordinate")]);
  expect(receipts.consume(coordinator)).toBe(true);
});

test("task origin comes from a human message, not a tool or completion record", () => {
  const branch: Branch = [
    {
      type: "message",
      id: "request-one",
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "Fix this", timestamp: 0 },
    },
    message({ ...herdr, state: "done" }),
  ];
  expect(completionOrigin({ getBranch: () => branch, getSessionId: () => "session-one" })).toEqual(
    origin,
  );
});
