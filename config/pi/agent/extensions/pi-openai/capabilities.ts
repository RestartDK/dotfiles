import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LiveOpenAIModel = {
  id: string;
  created?: number;
};

type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ThinkingLevelMap = Partial<Record<PiThinkingLevel, OpenAIReasoningEffort | null>>;

type TimedSupport = {
  checkedAt: number;
  supported: boolean;
};

type TimedReasoning = {
  checkedAt: number;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
};

type TimedContextWindow = {
  checkedAt: number;
  value: number;
};

type CapabilityCacheEntry = {
  created?: number;
  responses?: TimedSupport;
  reasoning?: TimedReasoning;
  contextWindow?: TimedContextWindow;
  imageInput?: TimedSupport;
};

type CapabilityCache = {
  version: 2;
  models: Record<string, CapabilityCacheEntry>;
};

type LegacyReasoningCache = {
  version: 1;
  models: Record<string, unknown>;
};

type ProbeHttpResult = {
  status: number;
  ok: boolean;
  body: string;
};

type ProbeOutcome = "supported" | "unsupported" | "unknown";

type ReasoningEffortProbe = {
  effort: OpenAIReasoningEffort;
  outcome: ProbeOutcome;
  advertisedEfforts?: OpenAIReasoningEffort[];
};

type ReasoningProbeResult = Pick<TimedReasoning, "reasoning" | "thinkingLevelMap">;

export type ModelCapabilityFallback = {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  contextWindow: number;
  imageInput: boolean;
};

export type ResolvedModelCapabilities = ModelCapabilityFallback & {
  responses: boolean | undefined;
};

export type CapabilityCacheState = {
  cache: CapabilityCache;
  path: string;
  changed: boolean;
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const CACHE_VERSION = 2;
const CAPABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const CONTEXT_REQUEST_TIMEOUT_MS = 180_000;
const CONTEXT_TRUNCATION_RESERVE_TOKENS = 3_000;
const MAX_CONTEXT_PROBE_TOKENS = 4_500_000;
const PI_THINKING_LEVELS: PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const REASONING_EFFORTS: OpenAIReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
const ENABLED_REASONING_EFFORTS: OpenAIReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
const PROBE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const COMMON_CONTEXT_WINDOWS = [
  4_096, 8_192, 16_384, 32_768, 65_536, 114_688, 128_000, 131_072, 200_000, 256_000, 262_144,
  272_000, 400_000, 524_288, 1_000_000, 1_047_576, 1_048_576, 1_050_000, 2_000_000, 2_097_152,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalizeThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
  if (!isRecord(value)) return undefined;

  const thinkingLevelMap: ThinkingLevelMap = {};
  for (const level of PI_THINKING_LEVELS) {
    const mapped = value[level];
    if (mapped === null || REASONING_EFFORTS.some((effort) => effort === mapped)) {
      thinkingLevelMap[level] = mapped as OpenAIReasoningEffort | null;
    }
  }

  return Object.keys(thinkingLevelMap).length > 0 ? thinkingLevelMap : undefined;
}

function normalizeTimedSupport(value: unknown): TimedSupport | undefined {
  if (
    !isRecord(value) ||
    typeof value.checkedAt !== "number" ||
    typeof value.supported !== "boolean"
  ) {
    return undefined;
  }
  return { checkedAt: value.checkedAt, supported: value.supported };
}

function normalizeTimedReasoning(value: unknown): TimedReasoning | undefined {
  if (
    !isRecord(value) ||
    typeof value.checkedAt !== "number" ||
    typeof value.reasoning !== "boolean"
  ) {
    return undefined;
  }

  const thinkingLevelMap = normalizeThinkingLevelMap(value.thinkingLevelMap);
  if (value.reasoning && thinkingLevelMap === undefined) return undefined;

  return {
    checkedAt: value.checkedAt,
    reasoning: value.reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

function normalizeTimedContextWindow(value: unknown): TimedContextWindow | undefined {
  if (!isRecord(value) || typeof value.checkedAt !== "number" || !isPositiveInteger(value.value))
    return undefined;
  return { checkedAt: value.checkedAt, value: value.value };
}

function emptyCache(): CapabilityCache {
  return { version: CACHE_VERSION, models: {} };
}

function normalizeCurrentCache(value: unknown): CapabilityCache | undefined {
  if (!isRecord(value) || value.version !== CACHE_VERSION || !isRecord(value.models))
    return undefined;

  const cache = emptyCache();
  for (const [id, candidate] of Object.entries(value.models)) {
    if (!isRecord(candidate)) continue;

    const responses = normalizeTimedSupport(candidate.responses);
    const reasoning = normalizeTimedReasoning(candidate.reasoning);
    const contextWindow = normalizeTimedContextWindow(candidate.contextWindow);
    const imageInput = normalizeTimedSupport(candidate.imageInput);

    cache.models[id] = {
      ...(typeof candidate.created === "number" ? { created: candidate.created } : {}),
      ...(responses ? { responses } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(imageInput ? { imageInput } : {}),
    };
  }

  return cache;
}

function migrateLegacyCache(value: unknown): CapabilityCache | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.models)) return undefined;

  const legacy = value as LegacyReasoningCache;
  const cache = emptyCache();
  for (const [id, candidate] of Object.entries(legacy.models)) {
    if (!isRecord(candidate)) continue;

    const reasoning = normalizeTimedReasoning(candidate);
    if (!reasoning) continue;

    cache.models[id] = {
      ...(typeof candidate.created === "number" ? { created: candidate.created } : {}),
      reasoning,
    };
  }

  return cache;
}

function agentDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (!isNotFoundError(error)) console.warn(`[pi-openai] Failed to read ${path}:`, error);
    return undefined;
  }
}

export async function readCapabilityCache(): Promise<CapabilityCacheState> {
  const directory = agentDirectory();
  const path = join(directory, "pi-openai-cache.json");
  const current = await readJsonFile(path);
  const normalized = normalizeCurrentCache(current);
  if (normalized) return { cache: normalized, path, changed: false };

  const migratedCurrent = migrateLegacyCache(current);
  if (migratedCurrent) return { cache: migratedCurrent, path, changed: true };

  const legacyPath = join(directory, "openai-live-models-cache.json");
  const migratedLegacy = migrateLegacyCache(await readJsonFile(legacyPath));
  if (migratedLegacy) return { cache: migratedLegacy, path, changed: true };

  return { cache: emptyCache(), path, changed: false };
}

export async function writeCapabilityCache(state: CapabilityCacheState): Promise<void> {
  try {
    await mkdir(dirname(state.path), { recursive: true });
    await writeFile(state.path, `${JSON.stringify(state.cache, null, 2)}\n`, "utf8");
    state.changed = false;
  } catch (error) {
    console.warn(`[pi-openai] Failed to write ${state.path}:`, error);
  }
}

function entryMatchesModel(entry: CapabilityCacheEntry, model: LiveOpenAIModel): boolean {
  return model.created === undefined || entry.created === model.created;
}

function getModelEntry(cache: CapabilityCache, model: LiveOpenAIModel): CapabilityCacheEntry {
  const existing = cache.models[model.id];
  if (existing && entryMatchesModel(existing, model)) return existing;

  const entry: CapabilityCacheEntry = model.created !== undefined ? { created: model.created } : {};
  cache.models[model.id] = entry;
  return entry;
}

function isFresh(checkedAt: number, now: number): boolean {
  return now - checkedAt < CAPABILITY_TTL_MS;
}

async function postProbe(
  apiKey: string,
  path: string,
  payload: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ProbeHttpResult | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${OPENAI_BASE_URL}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { status: response.status, ok: response.ok, body: await response.text() };
  } catch (error) {
    if (!isRecord(error) || error.name !== "AbortError") {
      console.warn(`[pi-openai] Probe request to ${path} failed:`, error);
    }
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function isResponsesUnavailable(result: ProbeHttpResult): boolean {
  if (![400, 403, 404, 422].includes(result.status)) return false;
  return /not supported (?:in|on|with).*responses|responses.*not supported|does not exist|model not found|not have access|not available/i.test(
    result.body,
  );
}

async function probeResponses(apiKey: string, modelId: string): Promise<ProbeOutcome> {
  const result = await postProbe(apiKey, "responses", {
    model: modelId,
    input: "Return exactly: ok",
    max_output_tokens: 16,
    store: false,
  });

  if (!result) return "unknown";
  if (result.ok) return "supported";
  if (isResponsesUnavailable(result)) return "unsupported";
  return "unknown";
}

function parseSupportedReasoningEfforts(body: string): OpenAIReasoningEffort[] | undefined {
  const supportedSection = /\bsupported values?\b(?: are)?:([\s\S]*)/i.exec(body)?.[1];
  if (!supportedSection) return undefined;

  const supported = REASONING_EFFORTS.filter((effort) => {
    const quoted = new RegExp(`["']${effort}["']`, "i");
    return quoted.test(supportedSection);
  });
  return supported.length > 0 ? supported : undefined;
}

function isReasoningParameterError(result: ProbeHttpResult): boolean {
  if (![400, 404, 422].includes(result.status)) return false;
  return /reasoning(?:\.effort)?|reasoning effort/i.test(result.body);
}

async function probeReasoningEffort(
  apiKey: string,
  modelId: string,
  effort: OpenAIReasoningEffort,
): Promise<ReasoningEffortProbe> {
  const result = await postProbe(apiKey, "responses", {
    model: modelId,
    input: "Return exactly: ok",
    max_output_tokens: 16,
    store: false,
    reasoning: effort === "none" ? { effort } : { effort, summary: "auto" },
    ...(effort === "none" ? {} : { include: ["reasoning.encrypted_content"] }),
  });

  if (!result) return { effort, outcome: "unknown" };
  if (result.ok) return { effort, outcome: "supported" };
  if (isReasoningParameterError(result)) {
    const advertisedEfforts = parseSupportedReasoningEfforts(result.body);
    return {
      effort,
      outcome: "unsupported",
      ...(advertisedEfforts ? { advertisedEfforts } : {}),
    };
  }
  return { effort, outcome: "unknown" };
}

function reasoningResult(
  supportedEfforts: ReadonlySet<OpenAIReasoningEffort>,
): ReasoningProbeResult {
  const reasoning = ENABLED_REASONING_EFFORTS.some((effort) => supportedEfforts.has(effort));
  if (!reasoning) return { reasoning: false };

  return {
    reasoning: true,
    thinkingLevelMap: {
      off: supportedEfforts.has("none") ? "none" : null,
      minimal: supportedEfforts.has("minimal") ? "minimal" : null,
      low: supportedEfforts.has("low") ? "low" : null,
      medium: supportedEfforts.has("medium") ? "medium" : null,
      high: supportedEfforts.has("high") ? "high" : null,
      xhigh: supportedEfforts.has("xhigh") ? "xhigh" : null,
    },
  };
}

async function probeReasoning(
  apiKey: string,
  modelId: string,
): Promise<ReasoningProbeResult | undefined> {
  const minimal = await probeReasoningEffort(apiKey, modelId, "minimal");
  if (minimal.advertisedEfforts) return reasoningResult(new Set(minimal.advertisedEfforts));

  const remaining = await Promise.all(
    REASONING_EFFORTS.filter((effort) => effort !== "minimal").map((effort) =>
      probeReasoningEffort(apiKey, modelId, effort),
    ),
  );
  const outcomes = [minimal, ...remaining];
  const supportedEfforts = new Set(
    outcomes.filter(({ outcome }) => outcome === "supported").map(({ effort }) => effort),
  );
  const conclusive = outcomes.some(({ outcome }) => outcome !== "unknown");
  return conclusive ? reasoningResult(supportedEfforts) : undefined;
}

function isImageInputUnsupported(result: ProbeHttpResult): boolean {
  if (![400, 404, 415, 422].includes(result.status)) return false;
  return /(?:image|vision).*(?:not supported|unsupported|does not support)|(?:not supported|unsupported|does not support).*(?:image|vision)/i.test(
    result.body,
  );
}

async function probeImageInput(apiKey: string, modelId: string): Promise<ProbeOutcome> {
  const result = await postProbe(apiKey, "responses", {
    model: modelId,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Return exactly: ok" },
          { type: "input_image", image_url: PROBE_IMAGE },
        ],
      },
    ],
    max_output_tokens: 16,
    store: false,
  });

  if (!result) return "unknown";
  if (result.ok) return "supported";
  if (isImageInputUnsupported(result)) return "unsupported";
  return "unknown";
}

function extractInputTokenCount(body: string): number | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    if (!isRecord(value) || !isPositiveInteger(value.input_tokens)) return undefined;
    return value.input_tokens;
  } catch {
    return undefined;
  }
}

function extractUsedInputTokens(body: string): number | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    if (!isRecord(value) || !isRecord(value.usage) || !isPositiveInteger(value.usage.input_tokens))
      return undefined;
    return value.usage.input_tokens;
  } catch {
    return undefined;
  }
}

function contextWindowCandidates(knownContextWindows: readonly number[]): number[] {
  return Array.from(
    new Set([...COMMON_CONTEXT_WINDOWS, ...knownContextWindows].filter(isPositiveInteger)),
  ).sort((a, b) => a - b);
}

function inferContextWindow(
  retainedInputTokens: number,
  knownContextWindows: readonly number[],
): number {
  const estimated = retainedInputTokens + CONTEXT_TRUNCATION_RESERVE_TOKENS;
  const candidates = contextWindowCandidates(knownContextWindows);
  const nearest = candidates.reduce((best, candidate) =>
    Math.abs(candidate - estimated) < Math.abs(best - estimated) ? candidate : best,
  );
  const tolerance = Math.max(1_024, Math.round(estimated * 0.005));
  if (Math.abs(nearest - estimated) <= tolerance) return nearest;
  return Math.max(1_000, Math.round(estimated / 1_000) * 1_000);
}

async function countProbeInputTokens(
  apiKey: string,
  modelId: string,
  input: string,
): Promise<number | undefined> {
  const result = await postProbe(
    apiKey,
    "responses/input_tokens",
    { model: modelId, input },
    CONTEXT_REQUEST_TIMEOUT_MS,
  );
  if (!result?.ok) return undefined;
  return extractInputTokenCount(result.body);
}

async function probeContextWindow(
  apiKey: string,
  modelId: string,
  knownContextWindows: readonly number[],
): Promise<number | undefined> {
  const highestKnownContextWindow = Math.max(128_000, ...knownContextWindows);
  let targetTokens = Math.min(
    MAX_CONTEXT_PROBE_TOKENS,
    Math.ceil((highestKnownContextWindow + 65_536) / 1_000) * 1_000,
  );

  while (targetTokens <= MAX_CONTEXT_PROBE_TOKENS) {
    const input = "x ".repeat(targetTokens);
    const countedInputTokens = await countProbeInputTokens(apiKey, modelId, input);
    if (!countedInputTokens) return undefined;

    const result = await postProbe(
      apiKey,
      "responses",
      {
        model: modelId,
        input,
        max_output_tokens: 16,
        store: false,
        truncation: "auto",
      },
      CONTEXT_REQUEST_TIMEOUT_MS,
    );
    if (!result?.ok) return undefined;

    const usedInputTokens = extractUsedInputTokens(result.body);
    if (!usedInputTokens) return undefined;
    if (usedInputTokens + 128 < countedInputTokens) {
      return inferContextWindow(usedInputTokens, knownContextWindows);
    }
    if (targetTokens === MAX_CONTEXT_PROBE_TOKENS) return countedInputTokens;

    targetTokens = Math.min(MAX_CONTEXT_PROBE_TOKENS, targetTokens * 2);
  }

  return undefined;
}

export async function resolveModelCapabilities(
  apiKey: string,
  model: LiveOpenAIModel,
  fallback: ModelCapabilityFallback,
  knownContextWindows: readonly number[],
  state: CapabilityCacheState,
  now: number,
): Promise<ResolvedModelCapabilities> {
  const entry = getModelEntry(state.cache, model);
  const cachedResponses = entry.responses;
  if (!cachedResponses || !isFresh(cachedResponses.checkedAt, now)) {
    const outcome = await probeResponses(apiKey, model.id);
    if (outcome !== "unknown") {
      entry.responses = { checkedAt: now, supported: outcome === "supported" };
      state.changed = true;
    }
  }

  if (entry.responses?.supported !== false) {
    const cachedReasoning = entry.reasoning;
    if (!cachedReasoning || !isFresh(cachedReasoning.checkedAt, now)) {
      const reasoning = await probeReasoning(apiKey, model.id);
      if (reasoning) {
        entry.reasoning = { checkedAt: now, ...reasoning };
        state.changed = true;
      }
    }

    const cachedImageInput = entry.imageInput;
    if (!cachedImageInput || !isFresh(cachedImageInput.checkedAt, now)) {
      const outcome = await probeImageInput(apiKey, model.id);
      if (outcome !== "unknown") {
        entry.imageInput = { checkedAt: now, supported: outcome === "supported" };
        state.changed = true;
      }
    }

    const cachedContextWindow = entry.contextWindow;
    if (!cachedContextWindow || !isFresh(cachedContextWindow.checkedAt, now)) {
      const contextWindow = await probeContextWindow(apiKey, model.id, knownContextWindows);
      if (contextWindow) {
        entry.contextWindow = { checkedAt: now, value: contextWindow };
        state.changed = true;
      }
    }
  }

  const reasoning = entry.reasoning?.reasoning ?? fallback.reasoning;
  return {
    responses: entry.responses?.supported,
    reasoning,
    ...(reasoning
      ? { thinkingLevelMap: entry.reasoning?.thinkingLevelMap ?? fallback.thinkingLevelMap }
      : {}),
    contextWindow: entry.contextWindow?.value ?? fallback.contextWindow,
    imageInput: entry.imageInput?.supported ?? fallback.imageInput,
  };
}
