import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider, type Models } from "@earendil-works/pi-ai";
import { executionModels } from "../src/execution-models.js";

test("public model request boundary blocks direct compaction-style requests and keeps the selected provider", async () => {
  const faux = fauxProvider({ api: "execution-model-fixture", provider: "execution-model-fixture", models: [{ id: "fixture", input: ["text"] }] });
  const models = createModels(); models.setProvider(faux.provider);
  const model = faux.getModel();
  const context: Parameters<Models["completeSimple"]>[1] = { messages: [{ role: "user", content: "fixture", timestamp: 0 }] };
  let requests = 0, allowed = false;
  faux.setResponses([() => { requests += 1; return fauxAssistantMessage("control"); }, () => { requests += 1; return fauxAssistantMessage("guarded"); }]);
  const guarded = executionModels(models, async () => { if (!allowed) throw new Error("Unresolved fixture effect"); });
  expect((await models.completeSimple(model, context)).stopReason).toBe("stop");
  expect(requests).toBe(1);
  expect(guarded.getModel(model.provider, model.id)).toEqual(models.getModel(model.provider, model.id));
  await expect(guarded.completeSimple(model, context)).rejects.toThrow(/Unresolved fixture effect/);
  expect((await guarded.streamSimple(model, context).result()).stopReason).toBe("error");
  expect(requests).toBe(1);
  allowed = true;
  expect((await guarded.completeSimple(model, context)).stopReason).toBe("stop");
  expect(requests).toBe(2);
});

test("public model boundary rechecks after an awaited caller header transform", async () => {
  const faux = fauxProvider({ api: "execution-model-late", provider: "execution-model-late", models: [{ id: "fixture", input: ["text"] }] });
  const models = createModels(); models.setProvider(faux.provider);
  let allowed = true, requests = 0, transforms = 0;
  faux.setResponses([() => { requests += 1; return fauxAssistantMessage("must not dispatch"); }]);
  const guarded = executionModels(models, async () => { if (!allowed) throw new Error("Late unresolved effect"); });
  const result = await guarded.completeSimple(faux.getModel(), { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, {
    transformHeaders: async headers => { transforms += 1; allowed = false; return headers; },
  });
  expect(result.stopReason).toBe("error");
  expect(transforms).toBe(1);
  expect(requests).toBe(0);
});

test("owned deferred cleanup remains available while progress is blocked and preserves caller options", async () => {
  const faux = fauxProvider({ api: "execution-model-cleanup", provider: "execution-model-cleanup", models: [{ id: "fixture", input: ["text"] }] });
  const models = createModels();
  const cancel = faux.provider.cancelDeferred;
  assert.ok(cancel);
  const controller = new AbortController();
  let cancellations = 0, transforms = 0, progressChecks = 0;
  models.setProvider({ ...faux.provider, cancelDeferred: async (model, handle, options) => {
    cancellations += 1;
    expect(options?.headers?.["x-fixture-cancel"]).toBe("preserved");
    expect(options?.signal).toBe(controller.signal);
    expect(options?.timeoutMs).toBe(1234);
    await cancel(model, handle, options);
  } });
  faux.setResponses([fauxAssistantMessage("deferred fixture result")]);
  const model = faux.getModel();
  const pending = await models.complete(model, { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, { deferred: true });
  const handle = pending.deferred;
  assert.ok(handle);
  const guarded = executionModels(models, async () => { progressChecks += 1; throw new Error("Unresolved effect"); });
  await guarded.cancelDeferred(model, handle, {
    signal: controller.signal,
    timeoutMs: 1234,
    transformHeaders: async headers => { transforms += 1; return { ...headers, "x-fixture-cancel": "preserved" }; },
  });
  expect(cancellations).toBe(1);
  expect(transforms).toBe(1);
  expect(progressChecks).toBe(0);
  expect(faux.state.cancelledDeferred).toEqual([handle]);
});
