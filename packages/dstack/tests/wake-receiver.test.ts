import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  WakeReceiver,
  wakeMessageType,
} from "../../../config/pi/agent/extensions/pi-jobs/wake-receiver.ts";
import {
  type callWatches,
  type WatchRequest,
  type WatchView,
} from "../../../config/pi/agent/lib/dstack-watches.ts";

function persistedSession() {
  const root = mkdtempSync("/tmp/dwr-");
  const session = SessionManager.create(root, root);
  session.appendMessage({ role: "user", content: "Start", timestamp: 0 });
  return session;
}
function fixture(session = persistedSession()) {
  let idle = true;
  let sessionId = session.getSessionId();
  let ackFailure = false;
  let beforeClaimResponse: (() => void) | undefined;
  const requests: WatchRequest[] = [];
  const messages: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
  const statuses: (string | null)[] = [];
  let watch: WatchView = {
    id: "a".repeat(24),
    requestId: "tool-call",
    sessionId,
    trigger: { kind: "timer", at: 100 },
    deadline: 200,
    message: "Wake up",
    createdAt: 0,
    updatedAt: 100,
    state: { kind: "pending", result: { kind: "timer", at: 100 } },
  };
  const call: typeof callWatches = async (input) => {
    requests.push(input);
    if (input.op === "begin") {
      if (watch.state.kind !== "pending") throw new Error("Already claimed");
      watch = {
        ...watch,
        state: {
          kind: "delivering",
          result: watch.state.result,
          token: input.token,
          startedAt: 100,
        },
      };
      beforeClaimResponse?.();
    } else if (input.op === "ack") {
      if (ackFailure) throw new Error("Lost ack response");
      if (watch.state.kind !== "delivering") throw new Error("No claim");
      watch = {
        ...watch,
        state: {
          kind: "delivered",
          result: watch.state.result,
          token: input.token,
          entryId: input.entryId,
        },
      };
    }
    return { version: 1, now: 100, watches: [structuredClone(watch)] };
  };
  const ctx = { sessionManager: session, isIdle: () => idle };
  const send: ExtensionAPI["sendMessage"] = (message, options) => {
    expect(options).toEqual({ triggerTurn: true });
    expect(idle).toBe(true);
    messages.push(message);
  };
  const receiver = (customCall: typeof callWatches = call) =>
    new WakeReceiver(
      {
        ...ctx,
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => session.getSessionFile(),
          getEntries: () => session.getEntries(),
        },
      },
      send,
      (reason) => statuses.push(reason),
      customCall,
    );
  function persist() {
    const message = messages[0];
    if (!message) throw new Error("Missing send");
    return session.appendCustomMessageEntry(
      message.customType,
      message.content,
      message.display,
      message.details,
    );
  }
  return {
    session,
    call,
    requests,
    messages,
    statuses,
    receiver,
    persist,
    reopen: (file: string) => {
      session = SessionManager.open(file);
    },
    watch: () => watch,
    busy: () => {
      idle = false;
    },
    idle: () => {
      idle = true;
    },
    failAck: () => {
      ackFailure = true;
    },
    restoreAck: () => {
      ackFailure = false;
    },
    switchSession: () => {
      sessionId = "fork-session";
    },
    onClaim: (fn: () => void) => {
      beforeClaimResponse = fn;
    },
    wrongTarget: () => {
      watch.sessionId = "different-session";
    },
  };
}

test("busy native sessions do not enqueue or acknowledge; sends wait for visible receipts", async () => {
  const f = fixture();
  const receiver = f.receiver();
  f.busy();
  await receiver.tick();
  expect(f.requests.map((r) => r.op)).toEqual(["list"]);
  expect(f.messages).toHaveLength(0);
  f.idle();
  await receiver.tick();
  expect(f.messages).toHaveLength(1);
  expect(f.requests.some((r) => r.op === "ack")).toBe(false);
  await receiver.tick();
  expect(f.messages).toHaveLength(1);
  expect(f.statuses.some((s) => s?.includes("replay blocked"))).toBe(true);
  f.persist();
  await receiver.tick();
  expect(f.watch().state.kind).toBe("delivered");
  receiver.stop();
});

test("nonpersistent sessions leave wakes pending, and failed file writes cannot acknowledge memory-only receipts", async () => {
  const volatile = fixture(SessionManager.inMemory());
  const detached = volatile.receiver();
  await detached.tick();
  expect(volatile.messages).toHaveLength(0);
  expect(volatile.watch().state.kind).toBe("pending");
  expect(volatile.statuses.some((s) => s?.includes("persistent native session"))).toBe(true);
  detached.stop();

  const f = fixture();
  const receiver = f.receiver();
  const file = f.session.getSessionFile();
  if (!file) throw new Error("Missing persistent fixture");
  try {
    await receiver.tick();
    const saved = `${file}.saved`;
    await rename(file, saved);
    try {
      await mkdir(file);
      try {
        expect(() => f.persist()).toThrow();
      } finally {
        await rmdir(file);
      }
    } finally {
      await rename(saved, file);
    }
    expect(f.session.getEntries().some((e) => e.type === "custom_message")).toBe(true);
    await receiver.tick();
    expect(f.requests.filter((r) => r.op === "ack")).toHaveLength(0);
    expect(f.watch().state.kind).toBe("delivering");
  } finally {
    receiver.stop();
  }
});

test("a fresh session cannot acknowledge a buffered receipt before the native file exists", async () => {
  const root = await mkdtemp("/tmp/dwr-");
  const session = SessionManager.create(root, root);
  const f = fixture(session);
  const receiver = f.receiver();
  try {
    await receiver.tick();
    f.persist();
    await receiver.tick();
    expect(f.requests.filter((r) => r.op === "ack")).toHaveLength(0);
    expect(f.watch().state.kind).toBe("delivering");
    session.appendMessage({ role: "user", content: "Save the conversation", timestamp: 1 });
    await receiver.tick();
    expect(f.watch().state.kind).toBe("delivered");
    expect(f.messages).toHaveLength(1);
  } finally {
    receiver.stop();
  }
});

test("receipt reconciliation precedes an earlier pending watch after a lost acknowledgement", async () => {
  const f = fixture();
  const first = f.receiver();
  await first.tick();
  f.persist();
  f.failAck();
  await first.tick();
  first.stop();
  f.restoreAck();
  const earlier: WatchView = {
    ...f.watch(),
    id: "0".repeat(24),
    requestId: "earlier-later-timer",
    state: { kind: "pending", result: { kind: "timer", at: 200 } },
  };
  const order: string[] = [];
  const call: typeof callWatches = async (input, options) => {
    order.push(input.op);
    if (input.op === "list") return { version: 1, now: 200, watches: [earlier, f.watch()] };
    if (input.op === "begin" && input.id === earlier.id) {
      if (f.watch().state.kind === "delivering") throw new Error("Outstanding delivery");
      return {
        version: 1,
        now: 200,
        watches: [
          {
            ...earlier,
            state: {
              kind: "delivering",
              result: { kind: "timer", at: 200 },
              token: input.token,
              startedAt: 200,
            },
          },
        ],
      };
    }
    return f.call(input, options);
  };
  const resumed = f.receiver(call);
  await resumed.tick();
  expect(order).toEqual(["list", "ack", "begin"]);
  expect(f.watch().state.kind).toBe("delivered");
  expect(f.messages).toHaveLength(2);
  resumed.stop();
});

test("all-branch receipts survive malformed unrelated lines, reload and lost acknowledgement without another turn", async () => {
  const directory = await mkdtemp("/tmp/dwr-");
  const session = SessionManager.create(directory, directory);
  session.appendMessage({ role: "user", content: "Start", timestamp: 0 });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Ready" }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  });
  const f = fixture(session);
  const before = session.getLeafId();
  if (!before) throw new Error("Missing branch root");
  const first = f.receiver();
  await first.tick();
  const entryId = f.persist();
  const file = session.getSessionFile();
  if (!file) throw new Error("No native session file");
  const contents = await readFile(file, "utf8");
  const receiptLine = contents.split("\n").find((line) => line.includes(entryId));
  if (!receiptLine) throw new Error("Missing persisted receipt");
  await writeFile(file, contents.replace(receiptLine, receiptLine.slice(0, -1)));
  await first.tick();
  expect(f.requests.filter((r) => r.op === "ack")).toHaveLength(0);
  expect(f.watch().state.kind).toBe("delivering");
  await writeFile(file, contents);
  f.failAck();
  await first.tick();
  expect(f.watch().state.kind).toBe("delivering");
  first.stop();
  session.branch(before);
  expect(session.getBranch().some((e) => e.id === entryId)).toBe(false);
  await writeFile(
    file,
    contents.replace(receiptLine, `{"unrelated":\n${receiptLine}`) + '\n{"torn":',
  );
  const reopened = SessionManager.open(file);
  expect(
    reopened
      .getEntries()
      .some((e) => e.type === "custom_message" && e.customType === wakeMessageType),
  ).toBe(true);
  f.restoreAck();
  f.reopen(file);
  const second = f.receiver();
  await second.tick();
  expect(f.messages).toHaveLength(1);
  expect(f.watch().state.kind).toBe("delivered");
  expect(f.requests.filter((r) => r.op === "ack")).toHaveLength(2);
  second.stop();
  console.log(`Retained native receipt fixture: ${directory}`);
});

test("wrong session, session replacement, shutdown, and post-claim busy race never inject", async () => {
  const wrong = fixture();
  wrong.wrongTarget();
  await wrong.receiver().tick();
  expect(wrong.messages).toHaveLength(0);
  const switched = fixture();
  const receiver = switched.receiver();
  switched.onClaim(switched.switchSession);
  await receiver.tick();
  expect(switched.messages).toHaveLength(0);
  const stopped = fixture();
  const detached = stopped.receiver();
  stopped.onClaim(() => detached.stop());
  await detached.tick();
  expect(stopped.messages).toHaveLength(0);
  const busy = fixture();
  busy.onClaim(busy.busy);
  await busy.receiver().tick();
  expect(busy.messages).toHaveLength(0);
  expect(busy.statuses.some((s) => s?.includes("not queued"))).toBe(true);
});

test("concurrent receiver instances cannot publish the same wake; claimed-without-receipt reload stays blocked", async () => {
  const f = fixture();
  const first = f.receiver();
  const second = f.receiver();
  await Promise.all([first.tick(), second.tick()]);
  expect(f.messages).toHaveLength(1);
  first.stop();
  second.stop();
  const reloaded = f.receiver();
  await reloaded.tick();
  expect(f.messages).toHaveLength(1);
  expect(f.requests.filter((r) => r.op === "ack")).toHaveLength(0);
  reloaded.stop();
});
