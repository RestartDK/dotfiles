import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  backendModel,
  isRecord,
  type Backend,
  type ResolvedRoute,
  type WorkerInvocation,
} from "../../lib/model-policy";
import { capped, initialUsage, Protocol, type Failure, type UsageStats } from "./protocol";

export interface Invocation {
  command: string;
  args: string[];
}
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
  output: string;
  stderr: string;
  usage: UsageStats;
  toolUsed: boolean;
}
export interface Runtime {
  pi: (args: string[]) => Invocation;
  claude: (args: string[]) => Invocation;
  env: NodeJS.ProcessEnv;
  now: () => number;
}
const liveChildren = new Set<ChildProcess>();
function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {}
}
export function terminateLiveChildren() {
  for (const child of liveChildren) killGroup(child, "SIGKILL");
}
process.once("exit", terminateLiveChildren);

function getPiInvocation(args: string[]): Invocation {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script))
    return { command: process.execPath, args: [script, ...args] };
  if (!/^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase()))
    return { command: process.execPath, args };
  return { command: "pi", args };
}
const defaultRuntime: Runtime = {
  pi: getPiInvocation,
  claude: (args) => ({ command: "claude", args }),
  env: process.env,
  now: Date.now,
};

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

export function subscriptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      /^(?:HOME|PATH|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TERM|TZ|XDG_RUNTIME_DIR|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(
        key,
      )
    )
      safe[key] = value;
  }
  return safe;
}
export function claudeTools(tools: string[]): string[] {
  const mapped = new Map([
    ["read", "Read"],
    ["grep", "Grep"],
    ["find", "Glob"],
    ["ls", "Glob"],
    ["bash", "Bash"],
    ["edit", "Edit"],
    ["write", "Write"],
  ]);
  return [
    ...new Set(
      tools.map((tool) => {
        const name = mapped.get(tool);
        if (!name)
          throw new Error(
            `Claude cannot provide requested tool ${tool}; choose a Pi-only role instead.`,
          );
        return name;
      }),
    ),
  ];
}
const claudeIsolation = [
  "--safe-mode",
  "--setting-sources",
  "",
  "--settings",
  '{"disableAllHooks":true}',
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
];

interface ProcessResult {
  code: number;
  missing: boolean;
  cancelled: boolean;
  failure?: string;
  stdout: string;
  stderr: string;
}
async function runProcess(options: {
  invocation: Invocation;
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}): Promise<ProcessResult> {
  const result: ProcessResult = {
    code: 1,
    missing: false,
    cancelled: false,
    stdout: "",
    stderr: "",
  };
  if (options.signal?.aborted) return { ...result, cancelled: true };
  return new Promise((resolve) => {
    const child = spawn(options.invocation.command, options.invocation.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    liveChildren.add(child);
    let buffer = "";
    let bytes = 0;
    const decoder = new StringDecoder("utf8");
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (killTimer) return;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 1000);
      killTimer.unref();
    };
    const abort = () => {
      result.cancelled = true;
      terminate();
    };
    const receive = (text: string) => {
      if (result.failure) return;
      bytes += Buffer.byteLength(text);
      buffer += text;
      if (bytes > 16 * 1024 * 1024 || Buffer.byteLength(buffer) > 1024 * 1024) {
        result.failure = "Backend stdout limit exceeded";
        terminate();
        return;
      }
      if (!options.onLine) result.stdout += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      try {
        for (const line of lines) if (line.trim()) options.onLine?.(line);
      } catch (error) {
        result.failure = error instanceof Error ? error.message : String(error);
        terminate();
      }
      if (!options.onLine && Buffer.byteLength(result.stdout) > 64 * 1024) {
        result.failure = "Auth stdout limit exceeded";
        terminate();
      }
    };
    child.stdout.on("data", (data: Buffer) => receive(decoder.write(data)));
    child.stderr.on("data", (data: Buffer) => {
      result.stderr = capped(result.stderr + data.toString("utf8"), 16 * 1024);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      result.missing = "code" in error && error.code === "ENOENT" && existsSync(options.cwd);
      if (!result.missing) result.failure = "Could not start backend process";
    });
    child.on("close", (code, signal) => {
      receive(decoder.end());
      if (signal && !result.cancelled && !result.failure)
        result.failure = `Backend terminated by ${signal}`;
      if (buffer.trim() && options.onLine && !result.failure)
        result.failure = "Truncated backend event stream";
      if (killTimer) {
        killGroup(child, "SIGKILL");
        clearTimeout(killTimer);
      }
      options.signal?.removeEventListener("abort", abort);
      liveChildren.delete(child);
      result.code = code ?? 1;
      resolve(result);
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    if (!result.cancelled) child.stdin.end(options.input);
  });
}

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
    let mappedTools: string[] = [];
    try {
      if (task.route.chain.some((backend) => backend.kind === "claude-cli"))
        mappedTools = claudeTools(task.tools);
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
        const attempt = await this.attempt(task, backend, mappedTools, signal, (protocol) => {
          result.output = protocol.output;
          result.toolUsed ||= protocol.toolUsed;
          if (protocol.actualModel)
            result.actual = { backend: backend.kind, model: protocol.actualModel };
          update?.({ ...result, usage: protocol.usage });
        });
        result.outcome = signal?.aborted ? { kind: "cancelled" } : attempt.outcome;
        result.output = attempt.protocol.output;
        result.stderr = attempt.stderr;
        result.toolUsed ||= attempt.protocol.toolUsed;
        result.actual = attempt.protocol.actualModel
          ? { backend: backend.kind, model: attempt.protocol.actualModel }
          : undefined;
        for (const field of [
          "input",
          "output",
          "cacheRead",
          "cacheWrite",
          "cost",
          "turns",
        ] satisfies (keyof UsageStats)[])
          result.usage[field] += attempt.protocol.usage[field];
        result.usage.contextTokens = attempt.protocol.usage.contextTokens;
        result.attempts.push({
          backend,
          actualModel: attempt.protocol.actualModel,
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
    tools: string[],
    signal: AbortSignal | undefined,
    update: (protocol: Protocol) => void,
  ): Promise<{ outcome: Outcome; protocol: Protocol; stderr: string }> {
    const protocol = new Protocol(backend, tools);
    let promptDir: string | undefined;
    let stderr = "";
    const fail = (outcome: Outcome) => ({ outcome, protocol, stderr });
    try {
      let invocation: Invocation;
      let env = this.runtime.env;
      const input = `Delegated task:\n\n${task.task}`;
      if (backend.kind === "claude-cli") {
        env = subscriptionEnv(env);
        const auth = await runProcess({
          invocation: this.runtime.claude([
            "--safe-mode",
            "--setting-sources",
            "",
            "auth",
            "status",
            "--json",
          ]),
          cwd: task.cwd,
          env,
          input: "",
          signal,
        });
        stderr = auth.stderr;
        if (auth.cancelled || signal?.aborted) return fail({ kind: "cancelled" });
        if (auth.missing) return fail({ kind: "provider-failure", reason: "missing-cli" });
        if (auth.failure) return fail({ kind: "failed", reason: auth.failure });
        let status: unknown;
        try {
          status = JSON.parse(auth.stdout);
        } catch {
          return fail({ kind: "failed", reason: "Malformed Claude auth status" });
        }
        if (!isRecord(status) || typeof status.loggedIn !== "boolean")
          return fail({ kind: "failed", reason: "Malformed Claude auth status" });
        if (
          status.loggedIn &&
          (auth.code !== 0 ||
            typeof status.authMethod !== "string" ||
            typeof status.apiProvider !== "string")
        )
          return fail({ kind: "failed", reason: "Invalid Claude auth status" });
        if (
          !status.loggedIn ||
          status.authMethod !== "claude.ai" ||
          status.apiProvider !== "firstParty"
        )
          return fail({ kind: "provider-failure", reason: "auth" });
        const context: string[] = [];
        for (const path of task.contextFiles)
          context.push(`Instructions from ${path}:\n${await readFile(path, "utf8")}`);
        const prompt = [
          ...context,
          task.systemPrompt,
          "Use only the tools enabled in this Claude session. Pi-only extension tools and MCPs are unavailable. Read/Grep/Glob correspond to read/grep/find. Use Glob for directory entry discovery, not Bash unless Bash is explicitly enabled. Glob does not provide ls metadata or exact hidden-directory listing parity; report missing capabilities rather than emulating them with broader tools.",
        ].join("\n\n");
        promptDir = await mkdtemp(join(tmpdir(), "claude-subagent-"));
        const promptPath = join(promptDir, "prompt.md");
        await writeFile(promptPath, prompt, { mode: 0o600 });
        invocation = this.runtime.claude([
          "-p",
          "--model",
          backend.model,
          "--effort",
          backend.thinking,
          "--output-format",
          "stream-json",
          "--verbose",
          ...claudeIsolation,
          "--disable-slash-commands",
          "--no-chrome",
          "--no-session-persistence",
          "--permission-mode",
          "dontAsk",
          "--tools",
          tools.join(","),
          "--allowedTools",
          tools.join(","),
          "--append-system-prompt-file",
          promptPath,
        ]);
      } else {
        const { provider, id: model } = backend;
        const workerInvocation: WorkerInvocation = {
          profile: task.route.profile,
          selection: task.route.selection,
          attempt: task.route.chain.indexOf(backend),
        };
        let authText = "";
        const auth = await runProcess({
          invocation: this.runtime.pi(["auth", "check", "--provider", provider, "--json"]),
          cwd: task.cwd,
          env,
          input: "",
          signal,
          onLine: (line) => {
            authText += line;
          },
        });
        stderr = auth.stderr;
        if (auth.cancelled || signal?.aborted) return fail({ kind: "cancelled" });
        if (auth.missing) return fail({ kind: "provider-failure", reason: "missing-cli" });
        if (auth.failure) return fail({ kind: "failed", reason: auth.failure });
        let status: unknown;
        try {
          status = JSON.parse(authText);
        } catch {
          return fail({ kind: "failed", reason: "Malformed Pi auth status" });
        }
        if (
          !isRecord(status) ||
          status.provider !== provider ||
          !["ready", "not_ready"].includes(String(status.status))
        )
          return fail({ kind: "failed", reason: "Malformed Pi auth status" });
        if (status.status === "not_ready")
          return fail({ kind: "provider-failure", reason: "auth" });
        if (auth.code !== 0) return fail({ kind: "failed", reason: "Pi auth check failed" });
        promptDir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
        const prompt = join(promptDir, "prompt.md");
        await writeFile(prompt, task.systemPrompt, { mode: 0o600 });
        const args = [
          "--dstack-worker",
          JSON.stringify(workerInvocation),
          "--mode",
          "json",
          "-p",
          "--no-session",
          "--provider",
          provider,
          "--model",
          model,
          "--thinking",
          backend.thinking,
          "--append-system-prompt",
          prompt,
        ];
        if (task.tools.length) args.push("--tools", task.tools.join(","));
        else args.push("--no-tools");
        invocation = this.runtime.pi(args);
      }
      const processResult = await runProcess({
        invocation,
        cwd: task.cwd,
        env,
        input,
        signal,
        onLine: (line) => {
          protocol.accept(JSON.parse(line));
          update(protocol);
        },
      });
      stderr = processResult.stderr;
      if (processResult.cancelled || signal?.aborted) return fail({ kind: "cancelled" });
      if (processResult.missing) return fail({ kind: "provider-failure", reason: "missing-cli" });
      if (processResult.failure) return fail({ kind: "failed", reason: processResult.failure });
      if (!protocol.terminal)
        return fail({ kind: "failed", reason: "Backend exited without a terminal result" });
      if (protocol.terminal.kind === "failure")
        return fail(
          protocol.terminal.provider
            ? {
                kind: "provider-failure",
                reason: protocol.terminal.provider,
                resetAt: protocol.resetAt,
              }
            : { kind: "failed", reason: protocol.terminal.reason },
        );
      return fail(
        processResult.code === 0
          ? { kind: "success" }
          : { kind: "failed", reason: `Backend exited ${processResult.code}` },
      );
    } finally {
      if (promptDir) await rm(promptDir, { recursive: true, force: true });
    }
  }
}
