import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  CanUseTool,
  HookCallback,
  Options,
  Query,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Usage } from "@earendil-works/pi-ai";
import type { BashOperations, ExtensionContext } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
export const OUTPUT_LIMIT = 16_000;
export const BINDING_ENTRY = "claude-task-binding";
export const LIMITS = { turns: 30, budget: 5, runtimeMs: 15 * 60_000 };
export type Totals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};
export type Binding = { sessionId: string; cwd: string; totals: Totals };
export type TaskResult = {
  cwd: string;
  sessionId?: string;
  text: string;
  usage?: Usage;
} & (
  | { status: "success" }
  | { status: "cancelled"; reason: "user" | "timeout" }
  | { status: "error"; reason: "auth" | "execution" | "protocol" | "budget" | "turns" | "cleanup" }
);
export const zeroTotals = (): Totals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});
export function sessionId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new Error("Invalid Claude session id.");
  return value;
}
export function parseBinding(value: unknown): Binding | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("sessionId" in value) ||
    !("cwd" in value) ||
    !("totals" in value)
  )
    return;
  if (
    typeof value.sessionId !== "string" ||
    typeof value.cwd !== "string" ||
    !isAbsolute(value.cwd)
  )
    return;
  try {
    sessionId(value.sessionId);
  } catch {
    return;
  }
  const t = value.totals;
  if (
    !t ||
    typeof t !== "object" ||
    !("input" in t) ||
    !("output" in t) ||
    !("cacheRead" in t) ||
    !("cacheWrite" in t) ||
    !("cost" in t)
  )
    return;
  const { input, output, cacheRead, cacheWrite, cost } = t;
  if (
    typeof input !== "number" ||
    typeof output !== "number" ||
    typeof cacheRead !== "number" ||
    typeof cacheWrite !== "number" ||
    typeof cost !== "number"
  )
    return;
  if (![input, output, cacheRead, cacheWrite, cost].every((n) => Number.isFinite(n) && n >= 0))
    return;
  return {
    sessionId: value.sessionId,
    cwd: value.cwd,
    totals: { input, output, cacheRead, cacheWrite, cost },
  };
}
export function resumeBinding(bindings: Map<string, Binding>, id: string, cwd: string): Binding {
  const binding = bindings.get(sessionId(id));
  if (!binding || binding.cwd !== cwd)
    throw new Error(
      "Resume is only allowed for a Claude session bound to this canonical checkout on the current Pi branch.",
    );
  return binding;
}
export async function canonicalCheckout(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute Git checkout path.");
  return realpath(
    (
      await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 10_000 })
    ).stdout.trim(),
  );
}
export function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      /^(ANTHROPIC_|CLAUDE_|HERDR_|AWS_|AMAZON_|BEDROCK_|GOOGLE_|VERTEX_|AZURE_|FOUNDRY_|GCP_|CLOUD_)/.test(
        key,
      ) &&
      key !== "CLAUDE_CONFIG_DIR"
    )
      delete env[key];
  }
  for (const key of [
    "CLAUDECODE",
    "NODE_OPTIONS",
    "BUN_OPTIONS",
    "BASH_ENV",
    "ENV",
    "PI_HERDR_CLOSE_TAB",
  ])
    delete env[key];
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_DISABLE_AUTO_UPDATE = "1";
  return env;
}
export async function resolveClaude(env: NodeJS.ProcessEnv): Promise<string> {
  for (const directory of (env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    const path = join(directory, "claude");
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return await realpath(path);
    } catch {
      continue;
    }
  }
  throw new Error("Claude Code is not installed on PATH.");
}
export function requireSubscriptionAuth(value: unknown): void {
  if (
    !value ||
    typeof value !== "object" ||
    !("loggedIn" in value) ||
    value.loggedIn !== true ||
    !("authMethod" in value) ||
    value.authMethod !== "claude.ai" ||
    !("apiProvider" in value) ||
    value.apiProvider !== "firstParty"
  ) {
    throw new Error(
      "claude_task requires Claude Code's own claude.ai login, not an API key. Run env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN claude auth login in your terminal, then retry.",
    );
  }
}
export async function preflight(
  cli: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  let stdout: string;
  try {
    stdout = (
      await exec(cli, ["--setting-sources", "", "auth", "status"], {
        cwd,
        env,
        signal,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      })
    ).stdout;
  } catch (error) {
    if (signal.aborted) throw error;
    if (error && typeof error === "object" && "stdout" in error && typeof error.stdout === "string")
      stdout = error.stdout;
    else
      throw new Error(
        "Could not check Claude Code login. Install Claude Code and run claude auth login.",
      );
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Claude Code returned an invalid auth status; update the CLI and sign in.");
  }
  requireSubscriptionAuth(value);
}
export class WriterGate {
  private claude: { id: string; cwd?: string } | undefined;
  private local = new Set<string>();
  beginClaude(id: string): void {
    if (this.claude || this.local.size)
      throw new Error("Another Pi writer is active. Finish it before claude_task.");
    this.claude = { id };
  }
  bind(id: string, cwd: string): void {
    if (this.claude?.id !== id) throw new Error("Claude checkout lease lost.");
    this.claude.cwd = cwd;
  }
  endClaude(id: string): void {
    if (this.claude?.id === id) this.claude = undefined;
  }
  beginLocal(id: string): void {
    if (this.claude)
      throw new Error(
        `claude_task owns ${this.claude.cwd ?? "a checkout"}; local write/edit/bash is blocked until its worker closes.`,
      );
    this.local.add(id);
  }
  endLocal(id: string): void {
    this.local.delete(id);
  }
  beginTool(name: string, id: string, readOnlyHint: boolean | undefined): void {
    if (name === "claude_task" || name === "codemode" || readOnlyHint === true) return;
    this.beginLocal(id);
  }
  guardShell(operations: BashOperations): BashOperations {
    return {
      exec: async (command, cwd, options) => {
        const id = `user-bash/${randomUUID()}`;
        this.beginLocal(id);
        try {
          return await operations.exec(command, cwd, options);
        } finally {
          this.endLocal(id);
        }
      },
    };
  }
  get busy(): boolean {
    return this.claude !== undefined;
  }
}
export const forceApproval: HookCallback = async () => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: "Pi requires human approval.",
  },
});
function clean(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
export function permissionHandler(
  ui: { hasUI: boolean; ui: Pick<ExtensionContext["ui"], "confirm"> },
  cwd: string,
  signal: AbortSignal,
): CanUseTool {
  return async (name, input, options) => {
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    if (!ui.hasUI || signal.aborted || options.signal.aborted)
      return deny("No active Pi approval UI. Ask the user to run this task interactively.");
    if (name === "AskUserQuestion")
      return deny(
        "AskUserQuestion is not supported. Include the question in your final response for the Pi user.",
      );
    if (name === "Bash" && input.run_in_background === true)
      return deny("Background shell jobs are not supported by claude_task.");
    const detail = name === "Bash" ? input.command : (input.file_path ?? input.path ?? "");
    const description = typeof detail === "string" ? clean(detail) : "";
    if (description.length > 4000)
      return deny("Approval request exceeds the display limit; split it into smaller operations.");
    const approval = AbortSignal.any([signal, options.signal, AbortSignal.timeout(60_000)]);
    const allowed = await ui.ui.confirm(
      `Claude Code: ${clean(name)}`,
      `${cwd}\n${description || "Allow this tool once?"}`,
      { signal: approval, timeout: 60_000 },
    );
    return allowed && !approval.aborted
      ? { behavior: "allow", updatedInput: input }
      : deny("User denied, cancelled, or timed out.");
  };
}
export function taskOptions(
  cwd: string,
  cli: string,
  env: NodeJS.ProcessEnv,
  abort: AbortController,
  canUseTool: CanUseTool,
  resume?: string,
): Options {
  return {
    cwd,
    pathToClaudeCodeExecutable: cli,
    env,
    abortController: abort,
    resume,
    permissionMode: "default",
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: [],
    settings: {
      forceLoginMethod: "claudeai",
      permissions: { defaultMode: "default", ask: ["Bash", "Edit", "Write"] },
      disableAutoMode: "disable",
    },
    tools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write", "AskUserQuestion"],
    strictMcpConfig: true,
    mcpServers: {},
    hooks: { PreToolUse: [{ matcher: "Bash|Edit|Write", hooks: [forceApproval] }] },
    canUseTool,
    maxTurns: LIMITS.turns,
    maxBudgetUsd: LIMITS.budget,
    includePartialMessages: true,
  };
}
export function ownedProcess(): {
  spawn: NonNullable<Options["spawnClaudeCodeProcess"]>;
  close: () => Promise<void>;
} {
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> = Promise.resolve();
  let didClose = true;
  let failure: Error | undefined;
  return {
    spawn(options) {
      if (child) throw new Error("Only one Claude process is allowed per task.");
      const worker = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      child = worker;
      didClose = false;
      worker.stderr.resume();
      worker.on("error", (error) => {
        if (error.name !== "AbortError" || !options.signal.aborted) failure = error;
      });
      closed = new Promise<void>((resolve) =>
        worker.once("close", () => {
          didClose = true;
          resolve();
        }),
      );
      return worker;
    },
    async close() {
      if (!child) return;
      const worker = child;
      const kill = () => {
        if (didClose) return;
        try {
          if (process.platform !== "win32" && worker.pid) process.kill(-worker.pid, "SIGKILL");
          else worker.kill("SIGKILL");
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      };
      const timer = setTimeout(kill, 3000);
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            const timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "Claude worker did not close; checkout lease retained. Restart Pi only after checking its processes.",
                  ),
                ),
              10_000,
            );
            closed.finally(() => clearTimeout(timeout));
          }),
        ]);
        if (failure) throw failure;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
export function totalsFor(result: SDKResultMessage): Totals {
  const totals = zeroTotals();
  for (const usage of Object.values(result.modelUsage)) {
    totals.input += usage.inputTokens;
    totals.output += usage.outputTokens;
    totals.cacheRead += usage.cacheReadInputTokens;
    totals.cacheWrite += usage.cacheCreationInputTokens;
    totals.cost += usage.costUSD;
  }
  return totals;
}
export function usageDelta(total: Totals, before: Totals): Usage {
  const input = Math.max(0, total.input - before.input),
    output = Math.max(0, total.output - before.output);
  const cacheRead = Math.max(0, total.cacheRead - before.cacheRead),
    cacheWrite = Math.max(0, total.cacheWrite - before.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: Math.max(0, total.cost - before.cost),
    },
  };
}
export type TaskQuery = AsyncIterable<SDKMessage> & Pick<Query, "close">;
export async function consumeTask(options: {
  query: TaskQuery;
  cwd: string;
  expectedSessionId?: string;
  before: Totals;
  bind: (binding: Binding) => void;
  update: (text: string) => void;
}): Promise<TaskResult> {
  let id: string | undefined;
  let text = "";
  let terminal: SDKResultMessage | undefined;
  let lastUpdate = 0;
  for await (const message of options.query) {
    if ("session_id" in message && message.session_id) {
      const observed = sessionId(message.session_id);
      if (
        (id && observed !== id) ||
        (options.expectedSessionId && observed !== options.expectedSessionId)
      )
        throw new Error("Claude changed session identity during a task.");
      if (!id) {
        id = observed;
        options.bind({ sessionId: id, cwd: options.cwd, totals: options.before });
      }
    }
    if (
      message.type === "stream_event" &&
      message.event.type === "content_block_delta" &&
      message.event.delta.type === "text_delta"
    )
      text = (text + clean(message.event.delta.text)).slice(-OUTPUT_LIMIT);
    if (message.type === "tool_progress")
      text = (text + `\n[${clean(message.tool_name)} ${message.tool_use_id}]\n`).slice(
        -OUTPUT_LIMIT,
      );
    if (Date.now() - lastUpdate > 200 && text) {
      options.update(text);
      lastUpdate = Date.now();
    }
    if (message.type === "result") {
      if (terminal) throw new Error("More than one terminal result in a single Claude task.");
      terminal = message;
    }
  }
  if (!terminal || !id)
    return {
      status: "error",
      reason: "protocol",
      cwd: options.cwd,
      sessionId: id,
      text: "Claude closed without a terminal result.",
    };
  const totals = totalsFor(terminal);
  options.bind({ sessionId: id, cwd: options.cwd, totals });
  const base = { cwd: options.cwd, sessionId: id, usage: usageDelta(totals, options.before) };
  if (terminal.subtype === "success")
    return terminal.is_error
      ? {
          ...base,
          status: "error",
          reason: "execution",
          text: clean(terminal.result).slice(-OUTPUT_LIMIT),
        }
      : { ...base, status: "success", text: clean(terminal.result).slice(-OUTPUT_LIMIT) };
  return {
    ...base,
    status: "error",
    reason:
      terminal.subtype === "error_max_budget_usd"
        ? "budget"
        : terminal.subtype === "error_max_turns"
          ? "turns"
          : "execution",
    text: clean(terminal.errors.join("\n")).slice(-OUTPUT_LIMIT) || terminal.subtype,
  };
}

export interface TaskServices {
  canonicalCheckout: typeof canonicalCheckout;
  resolveClaude: typeof resolveClaude;
  preflight: typeof preflight;
  ownedProcess: typeof ownedProcess;
  query: (params: { prompt: string; options: Options }) => TaskQuery;
  runtimeMs: number;
}
export class TaskRunner {
  readonly gate: WriterGate;
  bindings = new Map<string, Binding>();
  private services: TaskServices;
  private active: { abort: AbortController; done: Promise<void> } | undefined;
  constructor(gate: WriterGate, services: TaskServices) {
    this.gate = gate;
    this.services = services;
  }
  async stop(): Promise<void> {
    const active = this.active;
    active?.abort.abort();
    await active?.done;
  }
  async execute(request: {
    toolCallId: string;
    params: { task: string; cwd: string; resume?: string };
    signal?: AbortSignal;
    ui: Parameters<typeof permissionHandler>[0];
    bind: (binding: Binding) => void;
    update: (text: string, sessionId?: string) => void;
    cleanupError: (message: string) => void;
  }): Promise<TaskResult> {
    const { toolCallId, params, signal } = request;
    this.gate.beginClaude(toolCallId);
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) abort.abort();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.active = { abort, done };
    let timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      abort.abort();
    }, this.services.runtimeMs);
    let cwd = params.cwd;
    let observed: string | undefined;
    let worker: ReturnType<typeof ownedProcess> | undefined;
    let task: TaskQuery | undefined;
    let phase: "auth" | "execution" = "execution";
    let result: TaskResult = {
      status: "error",
      reason: "execution",
      cwd,
      text: "Claude task did not complete.",
    };
    try {
      cwd = await this.services.canonicalCheckout(params.cwd);
      this.gate.bind(toolCallId, cwd);
      const binding = params.resume ? resumeBinding(this.bindings, params.resume, cwd) : undefined;
      observed = binding?.sessionId;
      const env = childEnvironment(process.env);
      const cli = await this.services.resolveClaude(env);
      abort.signal.throwIfAborted();
      phase = "auth";
      await this.services.preflight(cli, cwd, env, abort.signal);
      phase = "execution";
      abort.signal.throwIfAborted();
      worker = this.services.ownedProcess();
      task = this.services.query({
        prompt: params.task,
        options: {
          ...taskOptions(
            cwd,
            cli,
            env,
            abort,
            permissionHandler(request.ui, cwd, abort.signal),
            binding?.sessionId,
          ),
          spawnClaudeCodeProcess: worker.spawn,
        },
      });
      result = await consumeTask({
        query: task,
        cwd,
        expectedSessionId: binding?.sessionId,
        before: binding?.totals ?? zeroTotals(),
        bind: (value) => {
          observed = value.sessionId;
          this.bindings.set(value.sessionId, value);
          request.bind(value);
        },
        update: (text) => request.update(text, observed),
      });
      if (abort.signal.aborted)
        result = {
          ...result,
          status: "cancelled",
          reason: timeout ? "timeout" : "user",
          text: "Claude task cancelled.",
        };
    } catch (error) {
      result = abort.signal.aborted
        ? {
            status: "cancelled",
            reason: timeout ? "timeout" : "user",
            cwd,
            sessionId: observed,
            text: "Claude task cancelled.",
          }
        : {
            status: "error",
            reason: phase,
            cwd,
            sessionId: observed,
            text: error instanceof Error ? error.message : String(error),
          };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      const cleanupErrors: unknown[] = [];
      try {
        task?.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await worker?.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (cleanupErrors.length) {
          const text = cleanupErrors.map(String).join("\n");
          result = {
            ...result,
            status: "error",
            reason: "cleanup",
            text: `${result.text}\nClaude cleanup failed: ${text}`.slice(-OUTPUT_LIMIT),
          };
          request.cleanupError(`Claude cleanup failed; checkout lease retained. ${text}`);
        }
      } finally {
        if (!cleanupErrors.length) this.gate.endClaude(toolCallId);
        this.active = undefined;
        finish();
      }
    }

    return result;
  }
}
