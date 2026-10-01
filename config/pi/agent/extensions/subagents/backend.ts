import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { backendModel, type NativeTarget, type ResolvedRoute } from "../../lib/model-policy";
import {
  capped,
  initialUsage,
  isPiActivity,
  piFailure,
  type Failure,
  type PiActivity,
  type UsageStats,
} from "./protocol";

export interface BackendTask {
  route: ResolvedRoute;
  task: string;
  tools: string[];
  systemPrompt: string;
  cwd: string;
}
export type Outcome =
  | { kind: "success" }
  | { kind: "provider-failure"; reason: Failure }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" };
export type Attempt = { backend: NativeTarget; actualModel?: string } & (
  | Outcome
  | { kind: "cooldown"; until: number }
);
export interface Execution {
  outcome: Outcome;
  attempts: Attempt[];
  actual?: { backend: NativeTarget["kind"]; model: string };
  activity?: PiActivity;
  output: string;
  usage: UsageStats;
  toolUsed: boolean;
}
export interface SessionProgress {
  activity?: PiActivity;
  usage: UsageStats;
  output: string;
  toolUsed: boolean;
  actualModel?: string;
}
export interface WorkerSessionOptions {
  cwd: string;
  target: NativeTarget;
  systemPrompt: string;
  tools: string[];
  signal?: AbortSignal;
  onProgress?: (progress: SessionProgress) => void;
}
export interface WorkerSessionResult {
  outcome: Outcome;
  output: string;
  usage: UsageStats;
  toolUsed: boolean;
  actualModel?: string;
}
export interface WorkerSession {
  prompt(text: string): Promise<WorkerSessionResult>;
  dispose(): Promise<void>;
}
export interface Runtime {
  session: (options: WorkerSessionOptions) => Promise<WorkerSession>;
  now: () => number;
}

export interface SessionResultState {
  usage: UsageStats;
  output: string;
  toolUsed: boolean;
  actualModel?: string;
  outcome?: Outcome;
}

export function initialSessionResult(): SessionResultState {
  return { usage: initialUsage(), output: "", toolUsed: false };
}

export function terminalOutcome(state: SessionResultState): Outcome {
  return state.outcome ?? { kind: "failed", reason: "Session exited without a terminal result" };
}

function assistantText(message: AssistantMessage): string | undefined {
  const texts: string[] = [];
  for (const block of message.content) if (block.type === "text") texts.push(block.text);
  return texts.length ? capped(texts.join("\n")) : undefined;
}

function failureOutcome(reason: string): Outcome {
  const provider = piFailure(reason);
  return provider
    ? { kind: "provider-failure", reason: provider }
    : { kind: "failed", reason: capped(reason, 4096) };
}

function stopOutcome(message: AssistantMessage): Outcome | undefined {
  switch (message.stopReason) {
    case "error":
      return failureOutcome(message.errorMessage ?? "Unknown Pi error");
    case "stop":
    case "length":
      return { kind: "success" };
    case "aborted":
      return { kind: "failed", reason: "Pi aborted" };
    case "toolUse":
    case "pending":
    case "deferred":
      return undefined;
    default: {
      const exhaustive: never = message.stopReason;
      return exhaustive;
    }
  }
}

export function reduceSessionEvent(
  state: SessionResultState,
  event: AgentSessionEvent,
): SessionResultState {
  switch (event.type) {
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return { ...state, toolUsed: true };
    case "turn_end":
      return event.toolResults.length > 0 ? { ...state, toolUsed: true } : state;
    case "message_end": {
      const message = event.message;
      if (message.role === "toolResult") return { ...state, toolUsed: true };
      if (message.role !== "assistant") return state;
      const toolUsed = state.toolUsed || message.content.some((block) => block.type === "toolCall");
      const usage: UsageStats = {
        input: state.usage.input + message.usage.input,
        output: state.usage.output + message.usage.output,
        cacheRead: state.usage.cacheRead + message.usage.cacheRead,
        cacheWrite: state.usage.cacheWrite + message.usage.cacheWrite,
        cost: state.usage.cost + message.usage.cost.total,
        contextTokens: message.usage.totalTokens,
        turns: state.usage.turns + 1,
      };
      const served = message.responseModel;
      if (served !== undefined && served !== message.model)
        return {
          ...state,
          usage,
          toolUsed,
          outcome: {
            kind: "failed",
            reason: `Pi answered with ${message.provider}/${served}, not the requested ${message.provider}/${message.model}.`,
          },
        };
      return {
        ...state,
        usage,
        output: assistantText(message) ?? state.output,
        toolUsed,
        actualModel: `${message.provider}/${served ?? message.model}`,
        outcome: stopOutcome(message),
      };
    }
    default:
      return state;
  }
}

const ABORT_GRACE_MS = 5_000;

async function createPiSession(options: WorkerSessionOptions): Promise<WorkerSession> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [createCodemodeExtension()],
    appendSystemPrompt: [options.systemPrompt],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(options.target.provider, options.target.id);
  if (!model)
    throw new Error(`Unknown worker model ${options.target.provider}/${options.target.id}.`);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager: SessionManager.inMemory(options.cwd),
    model,
    thinkingLevel: options.target.thinking,
    tools: options.tools,
  });
  return {
    async prompt(text: string): Promise<WorkerSessionResult> {
      let state = initialSessionResult();
      const signal = options.signal;
      if (signal?.aborted)
        return {
          outcome: { kind: "cancelled" },
          output: state.output,
          usage: state.usage,
          toolUsed: state.toolUsed,
        };
      const abort = () => {
        session.abort().catch(() => {});
      };
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let resolveStop: (() => void) | undefined;
      const stopped = new Promise<"stopped">((resolve) => {
        resolveStop = () => resolve("stopped");
      });
      const requestStop = () => {
        abort();
        stopTimer ??= setTimeout(() => resolveStop?.(), ABORT_GRACE_MS);
      };
      const unsubscribe = session.subscribe((event) => {
        state = reduceSessionEvent(state, event);
        if (event.type === "agent_start" && signal?.aborted) requestStop();
        const activity = isPiActivity(event.type) ? event.type : undefined;
        if (activity !== undefined || event.type === "message_end")
          options.onProgress?.({
            activity,
            usage: state.usage,
            output: state.output,
            toolUsed: state.toolUsed,
            actualModel: state.actualModel,
          });
      });
      signal?.addEventListener("abort", requestStop, { once: true });
      try {
        await Promise.race([
          session.prompt(text).then(
            () => "settled" as const,
            (error) => {
              state = {
                ...state,
                outcome: failureOutcome(error instanceof Error ? error.message : String(error)),
              };
              return "settled" as const;
            },
          ),
          stopped,
        ]);
        if (signal?.aborted) state = { ...state, outcome: { kind: "cancelled" } };
      } finally {
        if (stopTimer !== undefined) clearTimeout(stopTimer);
        signal?.removeEventListener("abort", requestStop);
        unsubscribe();
      }
      return {
        outcome: terminalOutcome(state),
        output: state.output,
        usage: state.usage,
        toolUsed: state.toolUsed,
        actualModel: state.actualModel,
      };
    },
    async dispose() {
      session.dispose();
    },
  };
}

export const defaultRuntime: Runtime = { session: createPiSession, now: Date.now };

export class BackendRunner {
  private readonly cooldowns = new Map<string, number>();
  private readonly shutdown = new AbortController();
  constructor(private readonly runtime: Runtime = defaultRuntime) {}

  stop(): void {
    this.shutdown.abort();
  }

  async run(
    task: BackendTask,
    signal?: AbortSignal,
    update?: (execution: Execution) => void,
  ): Promise<Execution> {
    signal = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
    const result: Execution = {
      outcome: { kind: "failed", reason: "All configured routes are cooling down" },
      attempts: [],
      output: "",
      usage: initialUsage(),
      toolUsed: false,
    };
    if (signal.aborted) return { ...result, outcome: { kind: "cancelled" } };
    try {
      for (const backend of task.route.chain) {
        if (signal.aborted) {
          result.outcome = { kind: "cancelled" };
          break;
        }
        const key = `${backend.kind}/${backendModel(backend)}`;
        const now = this.runtime.now();
        for (const [endpoint, until] of this.cooldowns)
          if (until <= now) this.cooldowns.delete(endpoint);
        const until = this.cooldowns.get(key);
        if (until !== undefined) {
          result.attempts.push({ backend, kind: "cooldown", until });
          update?.(result);
          continue;
        }
        const base = { ...result.usage };
        const attempt = await this.attempt(task, backend, signal, (progress) => {
          result.activity = progress.activity ?? result.activity;
          result.usage = {
            input: base.input + progress.usage.input,
            output: base.output + progress.usage.output,
            cacheRead: base.cacheRead + progress.usage.cacheRead,
            cacheWrite: base.cacheWrite + progress.usage.cacheWrite,
            cost: base.cost + progress.usage.cost,
            turns: base.turns + progress.usage.turns,
            contextTokens: progress.usage.contextTokens,
          };
          result.output = progress.output || result.output;
          result.toolUsed ||= progress.toolUsed;
          if (progress.actualModel)
            result.actual = { backend: backend.kind, model: progress.actualModel };
          else if (!result.actual)
            result.actual = { backend: backend.kind, model: backendModel(backend) };
          update?.(result);
        });
        result.outcome = signal.aborted ? { kind: "cancelled" } : attempt.outcome;
        result.output = attempt.result.output;
        result.toolUsed ||= attempt.result.toolUsed;
        result.actual = attempt.result.actualModel
          ? { backend: backend.kind, model: attempt.result.actualModel }
          : undefined;
        for (const field of [
          "input",
          "output",
          "cacheRead",
          "cacheWrite",
          "cost",
          "turns",
        ] satisfies (keyof UsageStats)[])
          result.usage[field] += attempt.result.usage[field];
        result.usage.contextTokens = attempt.result.usage.contextTokens;
        result.attempts.push({
          backend,
          actualModel: attempt.result.actualModel,
          ...result.outcome,
        });
        update?.(result);
        if (result.outcome.kind !== "provider-failure") break;
        const failedAt = this.runtime.now();
        if (this.cooldowns.size >= 64) {
          const oldest = this.cooldowns.keys().next().value;
          if (oldest !== undefined) this.cooldowns.delete(oldest);
        }
        this.cooldowns.set(key, failedAt + 60_000);
        if (result.toolUsed) break;
      }
    } catch (error) {
      result.outcome = failureOutcome(error instanceof Error ? error.message : String(error));
    }
    if (
      result.toolUsed &&
      (result.outcome.kind === "failed" || result.outcome.kind === "provider-failure")
    ) {
      result.outcome = {
        kind: "failed",
        reason: `${result.outcome.reason}. Partial output retained after tool use; parent must reconcile before retrying.`,
      };
    }
    return result;
  }

  private async attempt(
    task: BackendTask,
    backend: NativeTarget,
    signal: AbortSignal | undefined,
    onProgress: (progress: SessionProgress) => void,
  ): Promise<{ outcome: Outcome; result: WorkerSessionResult }> {
    let session: WorkerSession | undefined;
    try {
      session = await this.runtime.session({
        cwd: task.cwd,
        target: backend,
        systemPrompt: task.systemPrompt,
        tools: [...new Set([...task.tools, "codemode"])],
        signal,
        onProgress,
      });
      const result = await session.prompt(`Delegated task:\n\n${task.task}`);
      return { outcome: result.outcome, result };
    } catch (error) {
      const outcome = failureOutcome(error instanceof Error ? error.message : String(error));
      return {
        outcome,
        result: { outcome, output: "", usage: initialUsage(), toolUsed: false },
      };
    } finally {
      await session?.dispose();
    }
  }
}
