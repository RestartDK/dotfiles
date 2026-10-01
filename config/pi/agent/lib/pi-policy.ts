import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ProviderRequestOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  isRecord,
  loadPolicy,
  parseEffort,
  type Effort,
  type NativeProvider,
  type Policy,
} from "./model-policy";

export { loadPolicy };
export { bindSessionPolicy } from "./session-policy";

const transports = {
  "openai-codex": [{ api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }],
  fireworks: [
    { api: "openai-completions", baseUrl: "https://api.fireworks.ai/inference/v1" },
    { api: "anthropic-messages", baseUrl: "https://api.fireworks.ai/inference" },
  ],
  openrouter: [{ api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" }],
  anthropic: [{ api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }],
  ollama: [{ api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" }],
} satisfies Record<NativeProvider, { api: Api; baseUrl: string }[]>;

export function authorizeModel(model: Model<Api>, profile = loadPolicy().profile): Policy {
  const policy = loadPolicy();
  if (policy.profile !== profile)
    throw new Error(
      "AI policy profile changed. Start a new session; history cannot cross billing profiles.",
    );
  const pins = Object.entries(transports).find(([provider]) => provider === model.provider)?.[1];
  if (!pins) throw new Error(`AI policy blocks unsupported provider ${model.provider}.`);
  if (
    !pins.some(
      (transport) =>
        model.api === transport.api && model.baseUrl.replace(/\/$/, "") === transport.baseUrl,
    )
  )
    throw new Error(
      `AI policy blocks API or endpoint substitution for ${model.provider}/${model.id}.`,
    );
  return policy;
}

export function authorizeHeaders(
  model: Model<Api>,
  headers: ProviderRequestOptions<Model<Api>>["headers"],
): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (
      ["host", ":authority"].includes(name.toLowerCase()) &&
      value !== new URL(model.baseUrl).host
    )
      throw new Error("AI policy blocks routing header substitution.");
  }
}

const effortRank = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
} satisfies Record<Effort, number>;

export function normalizeRequiredEffort(model: Model<Api>, requested: Effort): Effort {
  const effective = clampThinkingLevel(model, requested);
  if (effortRank[effective] < effortRank[requested])
    throw new Error(
      `AI policy blocks effort downgrade from ${requested} to ${effective}. Update the exact model's catalog before continuing.`,
    );
  return effective;
}

export function policyThinkingLevel(): Effort {
  return loadPolicy().parent.thinking;
}

export function authorizePayload(
  payload: unknown,
  model: Model<Api>,
  profile: Policy["profile"],
): unknown {
  const wire: unknown = JSON.parse(JSON.stringify(payload));
  authorizeModel(model, profile);
  if (!isRecord(wire) || wire.model !== model.id || "models" in wire || "fallbacks" in wire)
    throw new Error("AI policy blocks wire model substitution or fallback models.");
  return wire;
}

export function authorizeAttempt(
  serializedPayload: string,
  model: Model<Api>,
  profile: Policy["profile"],
): undefined {
  authorizePayload(JSON.parse(serializedPayload), model, profile);
  return undefined;
}

export function resolveExactModel(runtime: ModelRuntime, provider: string, id: string): Model<Api> {
  const model = runtime.getModel(provider, id);
  if (!model)
    throw new Error(
      `AI policy cannot resolve exact model ${provider}/${id}. Update the catalog or start a new session; no provider fallback is allowed.`,
    );
  authorizeModel(model);
  return model;
}

export function resolvePolicyCli(options: {
  cliProvider?: string;
  cliModel?: string;
  cliThinking?: Effort;
  modelRuntime: ModelRuntime;
}): { model?: Model<Api>; thinkingLevel?: Effort; error?: string } {
  try {
    if (options.cliModel === undefined) {
      if (options.cliProvider !== undefined)
        throw new Error("AI policy requires an exact model with --provider.");
      return {};
    }
    let reference = options.cliModel;
    let thinkingLevel: Effort | undefined;
    const colon = reference.lastIndexOf(":");
    if (colon !== -1) {
      thinkingLevel = parseEffort(reference.slice(colon + 1));
      reference = reference.slice(0, colon);
    }
    let provider = options.cliProvider;
    if (provider !== undefined)
      reference = reference.startsWith(`${provider}/`)
        ? reference.slice(provider.length + 1)
        : reference;
    else {
      const slash = reference.indexOf("/");
      if (slash < 1)
        throw new Error("AI policy requires provider/model, not a fuzzy or bare model name.");
      provider = reference.slice(0, slash);
      reference = reference.slice(slash + 1);
    }
    const model = resolveExactModel(options.modelRuntime, provider, reference);
    return { model, thinkingLevel };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function policyDefault(runtime: ModelRuntime): { model: Model<Api>; thinkingLevel: Effort } {
  const target = loadPolicy().parent;
  return {
    model: resolveExactModel(runtime, target.provider, target.id),
    thinkingLevel: target.thinking,
  };
}
