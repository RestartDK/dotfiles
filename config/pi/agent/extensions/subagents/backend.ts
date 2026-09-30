import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  backendModel,
  parseEffort,
  type Backend,
  type ResolvedRoute,
  type WorkerInvocation,
} from "../../lib/model-policy";
import { configureInvocation } from "../../lib/pi-policy";
import {
  capped,
  initialUsage,
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
  contextFiles: string[];
}
export type Outcome =
  | { kind: "success" }
  | { kind: "provider-failure"; reason: Failure | "missing-cli"; resetAt?: number }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" };
export type Attempt = { backend: Backend; actualModel?: string } & (
  | Outcome
  | { kind: "cooldown"; until: number }
);
export interface Execution {
  outcome: Outcome;
  attempts: Attempt[];
  actual?: { backend: Backend["kind"]; model: string };
  activity?: PiActivity;
  output: string;
  stderr: string;
  usage: UsageStats;
  toolUsed: boolean;
}
export interface WorkerSessionOptions {
  cwd: string;
  provider: string;
  model: string;
  thinking: string;
  systemPrompt: string;
  tools: string[];
  signal?: AbortSignal;
  onActivity?: (activity: PiActivity) => void;
}
export interface WorkerSessionResult {
  outcome: Outcome;
  output: string;
  stderr: string;
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

export function instructionFiles(cwd: string, agentDir: string): string[] {
  const directories: string[] = [];
  let current = cwd;
  while (true) {
    directories.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const files: string[] = [];
  for (const directory of [agentDir, ...directories]) {
    const path = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"]
      .map((name) => join(directory, name))
      .find(existsSync);
    if (path && !files.includes(path)) files.push(path);
  }
  return files;
}

function isPiActivity(type: AgentSessionEvent["type"]): type is PiActivity {
  switch (type) {
    case "agent_start":
    case "turn_start":
    case "turn_end":
    case "message_start":
    case "tool_execution_start":
    case "auto_retry_start":
    case "auto_retry_end":
    case "compaction_start":
    case "compaction_end":
    case "agent_settled":
      return true;
    default:
      return false;
  }
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

async function createPiSession(options: WorkerSessionOptions): Promise<WorkerSession> {
  const {
    createAgentSession,
    createCodemodeExtension,
    DefaultResourceLoader,
    getAgentDir,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import("@earendil-works/pi-coding-agent");
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    extensionFactories: [createCodemodeExtension()],
    appendSystemPrompt: [options.systemPrompt],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(options.provider, options.model);
  if (!model) throw new Error(`Unknown worker model ${options.provider}/${options.model}.`);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime,
    sessionManager: SessionManager.inMemory(options.cwd),
    model,
    thinkingLevel: parseEffort(options.thinking),
    tools: options.tools,
  });
  return {
    async prompt(text: string): Promise<WorkerSessionResult> {
      const usage = initialUsage();
      let output = "";
      let toolUsed = false;
      let actualModel: string | undefined;
      let outcome: Outcome | undefined;
      const unsubscribe = session.subscribe((event) => {
        if (isPiActivity(event.type)) options.onActivity?.(event.type);
        switch (event.type) {
          case "tool_execution_start":
          case "tool_execution_update":
          case "tool_execution_end":
            toolUsed = true;
            break;
          case "turn_end":
            if (event.toolResults.length > 0) toolUsed = true;
            break;
          case "message_end": {
            const message = event.message;
            if (message.role === "toolResult") {
              toolUsed = true;
              break;
            }
            if (message.role !== "assistant") break;
            if (message.content.some((block) => block.type === "toolCall")) toolUsed = true;
            usage.turns++;
            usage.input += message.usage.input;
            usage.output += message.usage.output;
            usage.cacheRead += message.usage.cacheRead;
            usage.cacheWrite += message.usage.cacheWrite;
            usage.contextTokens = message.usage.totalTokens;
            usage.cost += message.usage.cost.total;
            actualModel = `${message.provider}/${message.model}`;
            output = assistantText(message) ?? output;
            switch (message.stopReason) {
              case "error":
                outcome = failureOutcome(message.errorMessage ?? "Unknown Pi error");
                break;
              case "stop":
              case "length":
                outcome = { kind: "success" };
                break;
              case "aborted":
                outcome = { kind: "failed", reason: "Pi aborted" };
                break;
              default:
                outcome = undefined;
            }
            break;
          }
        }
      });
      if (options.signal?.aborted) {
        unsubscribe();
        return { outcome: { kind: "cancelled" }, output, stderr: "", usage, toolUsed, actualModel };
      }
      const abort = () => {
        void session.abort();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        await session.prompt(text);
      } catch (error) {
        outcome = failureOutcome(error instanceof Error ? error.message : String(error));
      } finally {
        options.signal?.removeEventListener("abort", abort);
        unsubscribe();
      }
      if (options.signal?.aborted) outcome = { kind: "cancelled" };
      return {
        outcome: outcome ?? { kind: "failed", reason: "Session exited without a terminal result" },
        output,
        stderr: "",
        usage,
        toolUsed,
        actualModel,
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
      stderr: "",
      usage: initialUsage(),
      toolUsed: false,
    };
    if (signal.aborted) return { ...result, outcome: { kind: "cancelled" } };
    try {
      for (const backend of task.route.chain) {
        if (signal?.aborted) {
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
        const attempt = await this.attempt(task, backend, signal, (activity) => {
          result.activity = activity;
          result.actual = { backend: backend.kind, model: backendModel(backend) };
          update?.(result);
        });
        result.outcome = signal?.aborted ? { kind: "cancelled" } : attempt.outcome;
        result.output = attempt.result.output;
        result.stderr = attempt.result.stderr;
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
        const reset = result.outcome.resetAt;
        const failedAt = this.runtime.now();
        const expires =
          reset !== undefined && reset > failedAt
            ? Math.min(reset, failedAt + 24 * 60 * 60 * 1000)
            : failedAt + 60_000;
        if (this.cooldowns.size >= 64) {
          const oldest = this.cooldowns.keys().next().value;
          if (oldest !== undefined) this.cooldowns.delete(oldest);
        }
        this.cooldowns.set(key, expires);
        if (result.toolUsed) break;
      }
    } catch (error) {
      result.outcome = {
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
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
    backend: Backend,
    signal: AbortSignal | undefined,
    onActivity: (activity: PiActivity) => void,
  ): Promise<{ outcome: Outcome; result: WorkerSessionResult }> {
    const workerInvocation: WorkerInvocation = {
      profile: task.route.profile,
      selection: task.route.selection,
      attempt: task.route.chain.indexOf(backend),
    };
    let session: WorkerSession | undefined;
    try {
      configureInvocation(["--dstack-worker", JSON.stringify(workerInvocation)]);
      session = await this.runtime.session({
        cwd: task.cwd,
        provider: backend.provider,
        model: backend.id,
        thinking: backend.thinking,
        systemPrompt: task.systemPrompt,
        tools: [...new Set([...task.tools, "codemode"])],
        signal,
        onActivity,
      });
      const result = await session.prompt(`Delegated task:\n\n${task.task}`);
      return { outcome: result.outcome, result };
    } catch (error) {
      const outcome: Outcome = {
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
      return {
        outcome,
        result: {
          outcome,
          output: "",
          stderr: "",
          usage: initialUsage(),
          toolUsed: false,
        },
      };
    } finally {
      await session?.dispose();
    }
  }
}
