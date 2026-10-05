import assert from "node:assert/strict";
import { test } from "node:test";
import noOffers from "./index.ts";

function harness() {
  const hooks = new Map();
  const warnings = [];
  noOffers({
    on(name, handler) {
      hooks.set(name, handler);
    },
    sendUserMessage() {
      throw new Error("A warning must not impersonate the user");
    },
    sendMessage() {
      throw new Error("A warning must not enqueue an agent turn");
    },
  });
  const context = {
    hasUI: true,
    isIdle: () => true,
    ui: { notify: (...args) => warnings.push(args) },
  };
  return { hooks, warnings, context };
}

test("a trailing offer warns without inventing a user message or agent turn", () => {
  const { hooks, warnings, context } = harness();
  hooks.get("before_agent_start")({ prompt: "fix this now" }, context);
  hooks.get("agent_end")(
    {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Want me to run the focused test?" }],
        },
      ],
    },
    context,
  );
  hooks.get("agent_settled")({}, context);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /offer/i);
  assert.equal(warnings[0][1], "warning");
});

test("a repeated settle does not repeat the warning", () => {
  const { hooks, warnings, context } = harness();
  hooks.get("before_agent_start")({ prompt: "carry on" }, context);
  hooks.get("agent_end")(
    { messages: [{ role: "assistant", content: "Say the word and I will finish the tests." }] },
    context,
  );
  hooks.get("agent_settled")({}, context);
  hooks.get("agent_settled")({}, context);
  assert.equal(warnings.length, 1);
});

test("an explanation turn is not permission to continue work", () => {
  const { hooks, warnings, context } = harness();
  hooks.get("before_agent_start")({ prompt: "why does this happen?" }, context);
  hooks.get("agent_end")(
    { messages: [{ role: "assistant", content: "Want me to fix it?" }] },
    context,
  );
  hooks.get("agent_settled")({}, context);
  assert.equal(warnings.length, 0);
});

test("separate extension instances do not share a user's task", () => {
  const first = harness();
  const second = harness();
  first.hooks.get("before_agent_start")({ prompt: "carry on" }, first.context);
  second.hooks.get("before_agent_start")({ prompt: "explain this" }, second.context);
  first.hooks.get("agent_end")(
    { messages: [{ role: "assistant", content: "Want me to finish the tests?" }] },
    first.context,
  );
  first.hooks.get("agent_settled")({}, first.context);
  assert.equal(first.warnings.length, 1);
  assert.equal(second.warnings.length, 0);
});
