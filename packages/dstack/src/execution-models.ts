import type { Models, ModelsRequestTransforms } from "@earendil-works/pi-ai";

export function executionModels(models: Models, assertProgress: () => Promise<void>): Models {
  function transform(original: ModelsRequestTransforms["transformHeaders"]): NonNullable<ModelsRequestTransforms["transformHeaders"]> {
    return async headers => {
      await assertProgress();
      const result = original === undefined ? headers : await original(headers);
      await assertProgress();
      return result;
    };
  }
  function options<T extends ModelsRequestTransforms>(original?: T) {
    return Object.assign({}, original, { transformHeaders: transform(original?.transformHeaders) });
  }
  const requests: Pick<Models, "stream" | "complete" | "streamSimple" | "completeSimple" | "streamDeferred" | "fetchDeferred" | "generateImages" | "classify"> = {
    stream: (model, context, input) => models.stream(model, context, options(input)),
    complete: async (model, context, input) => { await assertProgress(); return models.complete(model, context, options(input)); },
    streamSimple: (model, context, input) => models.streamSimple(model, context, options(input)),
    completeSimple: async (model, context, input) => { await assertProgress(); return models.completeSimple(model, context, options(input)); },
    streamDeferred: (model, handle, input) => models.streamDeferred(model, handle, options(input)),
    fetchDeferred: async (model, handle, input) => { await assertProgress(); return models.fetchDeferred(model, handle, options(input)); },
    generateImages: async (model, context, input) => { await assertProgress(); return models.generateImages(model, context, options(input)); },
    classify: async (model, context, input) => { await assertProgress(); return models.classify(model, context, options(input)); },
  };
  return new Proxy(models, {
    get(target, key, receiver): unknown {
      switch (key) {
        case "stream": return requests.stream;
        case "complete": return requests.complete;
        case "streamSimple": return requests.streamSimple;
        case "completeSimple": return requests.completeSimple;
        case "streamDeferred": return requests.streamDeferred;
        case "fetchDeferred": return requests.fetchDeferred;
        case "generateImages": return requests.generateImages;
        case "classify": return requests.classify;
        default: return Reflect.get(target, key, receiver);
      }
    },
  });
}
