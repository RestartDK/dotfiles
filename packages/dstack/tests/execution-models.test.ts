import { expect, test } from "bun:test";
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
