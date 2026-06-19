import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  readCapabilityCache,
  resolveModelCapabilities,
  writeCapabilityCache,
} from "./capabilities.ts";
import type {
  LiveOpenAIModel,
  ModelCapabilityFallback,
  ResolvedModelCapabilities,
} from "./capabilities.ts";
import {
  stripUnreplayableReasoningBlocksFromMessages,
  stripUnreplayableReasoningItemsFromPayload,
} from "./reasoning-replay.ts";

type OpenAIModelList = {
  data?: Array<{
    id?: unknown;
    created?: unknown;
  }>;
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 128_000;
const CAPABILITY_PROBE_CONCURRENCY = 2;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function isPublicSnapshot(id: string): boolean {
  return /-\d{4}-\d{2}-\d{2}$|-\d{8}$/.test(id);
}

function isNonChatModel(id: string): boolean {
  return /embedding|image|tts|audio|transcribe|whisper|moderation|dall-e|search-api|realtime/i.test(id);
}

function shouldExposeLiveModel(id: string): boolean {
  const lower = id.toLowerCase();

  if (isPublicSnapshot(lower)) return false;
  if (isNonChatModel(lower)) return false;

  return lower.startsWith("gpt-") || /^o\d/.test(lower) || lower.includes("alpha") || lower.includes("codex");
}

function fromBuiltInModel(model: Model<Api>) {
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: model.compat,
  };
}

function fromLiveModel(model: LiveOpenAIModel, capabilities: ResolvedModelCapabilities) {
  const input: Array<"text" | "image"> = capabilities.imageInput ? ["text", "image"] : ["text"];

  return {
    id: model.id,
    name: model.id,
    api: "openai-responses" as const,
    baseUrl: OPENAI_BASE_URL,
    reasoning: capabilities.reasoning,
    thinkingLevelMap: capabilities.reasoning ? capabilities.thinkingLevelMap : undefined,
    input,
    cost: ZERO_COST,
    contextWindow: capabilities.contextWindow,
    maxTokens: Math.min(DEFAULT_MAX_TOKENS, capabilities.contextWindow),
    compat: undefined,
  };
}

async function fetchOpenAIModels(apiKey: string): Promise<LiveOpenAIModel[]> {
  try {
    const response = await fetch(`${OPENAI_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      console.warn(`[pi-openai] Failed to list OpenAI models: HTTP ${response.status}`);
      return [];
    }

    const payload = (await response.json()) as OpenAIModelList;
    return (payload.data ?? [])
      .map((model) => {
        if (typeof model.id !== "string" || !shouldExposeLiveModel(model.id)) return undefined;

        return {
          id: model.id,
          ...(typeof model.created === "number" ? { created: model.created } : {}),
        };
      })
      .filter((model): model is LiveOpenAIModel => model !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    console.warn("[pi-openai] Failed to list OpenAI models:", error);
    return [];
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export default async function (pi: ExtensionAPI) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;

  const builtInModels = getModels("openai");
  const modelsById = new Map(builtInModels.map((model) => [model.id, fromBuiltInModel(model)]));
  const discoveredModels = await fetchOpenAIModels(apiKey);
  const liveModels = discoveredModels.filter((model) => !modelsById.has(model.id));
  const liveModelIds = new Set<string>();

  if (liveModels.length > 0) {
    const cacheState = await readCapabilityCache();
    const knownContextWindows = builtInModels.map((model) => model.contextWindow);
    const fallback: ModelCapabilityFallback = {
      reasoning: false,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      imageInput: false,
    };
    const now = Date.now();
    const resolved = await mapWithConcurrency(liveModels, CAPABILITY_PROBE_CONCURRENCY, async (model) => ({
      model,
      capabilities: await resolveModelCapabilities(
        apiKey,
        model,
        fallback,
        knownContextWindows,
        cacheState,
        now,
      ),
    }));

    for (const { model, capabilities } of resolved) {
      if (capabilities.responses === false) continue;
      modelsById.set(model.id, fromLiveModel(model, capabilities));
      liveModelIds.add(model.id);
    }

    if (cacheState.changed) await writeCapabilityCache(cacheState);
  }

  pi.registerProvider("openai", {
    name: "OpenAI",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "$OPENAI_API_KEY",
    models: Array.from(modelsById.values()),
  });

  pi.on("context", (event, ctx) => {
    if (ctx.model?.provider !== "openai" || !liveModelIds.has(ctx.model.id)) return;

    const messages = stripUnreplayableReasoningBlocksFromMessages(event.messages);
    if (messages !== undefined) return { messages };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openai" || !liveModelIds.has(ctx.model.id)) return;

    return stripUnreplayableReasoningItemsFromPayload(event.payload);
  });
}
