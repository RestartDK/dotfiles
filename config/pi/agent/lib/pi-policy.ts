import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ProviderRequestOptions,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  authorizeNative,
  isRecord,
  loadPolicy,
  parseEffort,
  parseWorkerInvocation,
  resolveWorkerInvocation,
  type Effort,
  type NativeProvider,
  type NativeTarget,
  type Policy,
  type WorkerInvocation,
} from "./model-policy";

export { loadPolicy };
export { bindSessionPolicy } from "./session-policy";

type Invocation =
  | { kind: "parent" }
  | { kind: "worker"; request: WorkerInvocation; target: NativeTarget };
let invocation: Invocation = { kind: "parent" };

export function configureInvocation(args: string[]): string[] {
  const end = args.indexOf("--");
  const flags = end === -1 ? args : args.slice(0, end);
  const index = flags.indexOf("--dstack-worker");
  if (index === -1) {
    invocation = { kind: "parent" };
    return args;
  }
  if (flags.lastIndexOf("--dstack-worker") !== index || flags[index + 1] === undefined)
    throw new Error("AI policy requires one worker invocation.");
  const request = parseWorkerInvocation(JSON.parse(flags[index + 1]));
  const target = resolveWorkerInvocation(loadPolicy(), request);
  invocation = { kind: "worker", request, target };
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

function workerTarget(policy: Policy): NativeTarget | undefined {
  switch (invocation.kind) {
    case "parent":
      return undefined;
    case "worker": {
      const current = resolveWorkerInvocation(policy, invocation.request);
      if (current.thinking !== invocation.target.thinking)
        throw new Error("AI policy changed worker effort. Restart the worker before continuing.");
      return current;
    }
    default: {
      const exhaustive: never = invocation;
      return exhaustive;
    }
  }
}

const transports = {
  openai: [{ api: "openai-responses", baseUrl: "https://api.openai.com/v1" }],
  "openai-codex": [{ api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }],
  anthropic: [{ api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }],
  fireworks: [
    { api: "openai-completions", baseUrl: "https://api.fireworks.ai/inference/v1" },
    { api: "anthropic-messages", baseUrl: "https://api.fireworks.ai/inference" },
  ],
  openrouter: [{ api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" }],
} satisfies Record<NativeProvider, { api: Api; baseUrl: string }[]>;

export function authorizeModel(model: Model<Api>, profile = loadPolicy().profile): Policy {
  const policy = loadPolicy();
  if (policy.profile !== profile)
    throw new Error(
      "AI policy profile changed. Start a new session; history cannot cross billing profiles.",
    );
  const target = authorizeNative(policy, model);
  const worker = workerTarget(policy);
  if (worker && (worker.provider !== model.provider || worker.id !== model.id))
    throw new Error("AI policy blocks changing the worker's resolved target.");
  if (
    !transports[target.provider].some(
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

export function authorizeRequestedEffort(level: Effort): void {
  const worker = workerTarget(loadPolicy());
  if (worker && worker.thinking !== level)
    throw new Error(
      `AI policy requires worker effort ${worker.thinking}; requested effort was ${level}.`,
    );
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

export function authorizeEffectiveEffort(model: Model<Api> | undefined, level: Effort): void {
  const worker = workerTarget(loadPolicy());
  if (!worker) return;
  if (!model)
    throw new Error("AI policy requires an exact worker model before normalizing effort.");
  const effective = normalizeRequiredEffort(model, worker.thinking);
  if (effective !== level)
    throw new Error(
      `AI policy requires worker effort ${worker.thinking}, normalized to ${effective}; effective effort was ${level}.`,
    );
}

export function workerRequestOptions(
  model: Model<Api>,
  options: SimpleStreamOptions = {},
): SimpleStreamOptions {
  const worker = workerTarget(loadPolicy());
  if (!worker) return options;
  const effective = normalizeRequiredEffort(model, worker.thinking);
  if (
    options.reasoning !== undefined &&
    options.reasoning !== worker.thinking &&
    options.reasoning !== effective
  )
    throw new Error(
      `AI policy requires worker effort ${effective}. Restart the worker with its declared effort.`,
    );
  return { ...options, reasoning: effective === "off" ? undefined : effective };
}

export function policyThinkingLevel(): Effort {
  const policy = loadPolicy();
  return (workerTarget(policy) ?? policy.parent).thinking;
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
  authorizeWireEffort(wire, model);
  return wire;
}

function authorizeWireEffort(wire: Record<string, unknown>, model: Model<Api>): void {
  const worker = workerTarget(loadPolicy());
  if (!worker) return;
  const effective = normalizeRequiredEffort(model, worker.thinking);
  const effort =
    effective === "off"
      ? "none"
      : model.api === "anthropic-messages" && effective === "minimal"
        ? "low"
        : effective;
  const controls = [
    "reasoning",
    "reasoning_effort",
    "thinking",
    "output_config",
    "enable_thinking",
    "chat_template_kwargs",
    "chat_template_args",
    "thinking_token_budget",
    "thinking_budget",
    "thinking_budget_tokens",
  ];
  let allowed: string[];
  let matches: boolean;
  if (model.api === "anthropic-messages") {
    allowed = ["thinking", "output_config"];
    const lastMessage: unknown = Array.isArray(wire.messages) ? wire.messages.at(-1) : undefined;
    const outputMatches =
      model.compat &&
      "supportsMidConvoEffort" in model.compat &&
      model.compat.supportsMidConvoEffort === true
        ? isRecord(wire.output_config) &&
          wire.output_config.effort === "high" &&
          isRecord(lastMessage) &&
          lastMessage.role === "system" &&
          Array.isArray(lastMessage.content) &&
          lastMessage.content.length === 0 &&
          isRecord(lastMessage.output_config) &&
          lastMessage.output_config.effort === effort
        : isRecord(wire.output_config) && wire.output_config.effort === effort;
    matches =
      isRecord(wire.thinking) &&
      (effective === "off"
        ? wire.thinking.type === "disabled" && wire.output_config === undefined
        : wire.thinking.type === "adaptive" &&
          !("budget_tokens" in wire.thinking) &&
          outputMatches);
  } else if (model.api === "openai-completions" && model.provider === "fireworks") {
    allowed = ["reasoning_effort"];
    matches = wire.reasoning_effort === effort;
  } else {
    allowed = ["reasoning"];
    matches =
      isRecord(wire.reasoning) &&
      wire.reasoning.effort === effort &&
      Object.keys(wire.reasoning).every((key) => ["effort", "summary"].includes(key));
  }
  if (!matches || controls.some((key) => !allowed.includes(key) && key in wire))
    throw new Error(
      `AI policy blocks worker wire effort substitution; required ${effective}. Restart the worker if its state is stale.`,
    );
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
  authorizeNative(loadPolicy(), { provider, id });
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
    if (options.cliThinking ?? thinkingLevel)
      authorizeRequestedEffort(options.cliThinking ?? thinkingLevel ?? "off");
    return { model, thinkingLevel };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function policyDefault(runtime: ModelRuntime): { model: Model<Api>; thinkingLevel: Effort } {
  const policy = loadPolicy();
  const target = workerTarget(policy) ?? policy.parent;
  return {
    model: resolveExactModel(runtime, target.provider, target.id),
    thinkingLevel: target.thinking,
  };
}
