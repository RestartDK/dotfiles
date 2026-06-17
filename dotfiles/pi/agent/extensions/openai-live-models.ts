import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModels } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

type OpenAIModelList = {
  data?: Array<{
    id?: unknown;
  }>;
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
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

function fromLiveModel(id: string) {
  return {
    id,
    name: id,
    api: "openai-responses" as const,
    baseUrl: OPENAI_BASE_URL,
    reasoning: false,
    input: ["text"] as const,
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

async function fetchOpenAIModelIds(apiKey: string): Promise<string[]> {
  const response = await fetch(`${OPENAI_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) return [];

  const payload = (await response.json()) as OpenAIModelList;
  return (payload.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string")
    .filter(shouldExposeLiveModel)
    .sort((a, b) => a.localeCompare(b));
}

export default async function (pi: ExtensionAPI) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;

  const builtInModels = getModels("openai").map(fromBuiltInModel);
  const modelsById = new Map(builtInModels.map((model) => [model.id, model]));

  for (const id of await fetchOpenAIModelIds(apiKey)) {
    if (!modelsById.has(id)) {
      modelsById.set(id, fromLiveModel(id));
    }
  }

  pi.registerProvider("openai", {
    name: "OpenAI",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "$OPENAI_API_KEY",
    models: Array.from(modelsById.values()),
  });
}
