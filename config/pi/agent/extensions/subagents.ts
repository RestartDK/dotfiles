import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type JsonRecord = Record<string, unknown>;

interface WorkerPreset {
  description?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  systemPrompt?: string;
}

interface SubagentsConfig {
  maxParallel: number;
  defaultTools: string[];
  agents: Record<string, WorkerPreset>;
}

interface WorkerTaskInput {
  agent?: string;
  task: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  systemPrompt?: string;
  cwd?: string;
}

interface ResolvedWorkerTask {
  name: string;
  task: string;
  model?: string;
  thinking?: string;
  tools: string[];
  systemPrompt: string;
  cwd: string;
}

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface WorkerResult {
  name: string;
  task: string;
  model?: string;
  thinking?: string;
  tools: string[];
  cwd: string;
  exitCode: number;
  messages: unknown[];
  stderr: string;
  output: string;
  usage: UsageStats;
  stopReason?: string;
  errorMessage?: string;
}

interface SubagentsDetails {
  results: WorkerResult[];
}

const MAX_TASKS = 8;
const OUTPUT_CAP_BYTES = 50 * 1024;
const WRITE_TOOLS = new Set(["edit", "write"]);
const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash"];

const DEFAULT_CONFIG: SubagentsConfig = {
  maxParallel: 4,
  defaultTools: DEFAULT_TOOLS,
  agents: {
    "scout-haiku": {
      description: "Fast read-only codebase reconnaissance.",
      model: "anthropic/claude-haiku-4-5",
      tools: DEFAULT_TOOLS,
      systemPrompt: [
        "You are scout-haiku, a fast read-only codebase reconnaissance worker.",
        "Find relevant files and facts quickly. Do not edit files.",
        "Return concise findings with exact file paths and line ranges where possible.",
      ].join("\n"),
    },
    "planner-gemini": {
      description: "Read-only planner that turns findings into a concrete plan.",
      model: "google/gemini-2.5-flash",
      tools: DEFAULT_TOOLS,
      systemPrompt: [
        "You are planner-gemini, a read-only planning worker.",
        "Do not edit files. Produce a concrete, ordered plan with risks and validation steps.",
      ].join("\n"),
    },
    "reviewer-sonnet": {
      description: "Read-only implementation reviewer.",
      model: "anthropic/claude-sonnet-4-5",
      tools: DEFAULT_TOOLS,
      systemPrompt: [
        "You are reviewer-sonnet, a read-only review worker.",
        "Review the requested code or diff for correctness, missing tests, safety, and unnecessary complexity.",
        "Do not edit files. Return prioritized findings with paths and line numbers.",
      ].join("\n"),
    },
    "worker-gpt-mini": {
      description: "Write-capable implementation worker. Run at most one at a time.",
      model: "openai/gpt-5.4-mini",
      tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
      systemPrompt: [
        "You are worker-gpt-mini, a focused implementation worker.",
        "Make only the requested changes. Keep the diff small. Report exactly what changed and what validation you ran.",
      ].join("\n"),
    },
  },
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): JsonRecord {
  if (!existsSync(path)) return {};

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (isRecord(parsed)) return parsed;
    console.warn(`[subagents] Ignoring ${path}: expected a JSON object.`);
    return {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[subagents] Ignoring ${path}: ${message}`);
    return {};
  }
}

function readStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const strings = value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
    return strings.length > 0 ? strings.map((item) => item.trim()) : undefined;
  }

  if (typeof value === "string") {
    const strings = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return strings.length > 0 ? strings : undefined;
  }

  return undefined;
}

function parsePreset(value: unknown): WorkerPreset | undefined {
  if (!isRecord(value)) return undefined;

  const preset: WorkerPreset = {};
  if (typeof value.description === "string" && value.description.trim().length > 0) {
    preset.description = value.description.trim();
  }
  if (typeof value.model === "string" && value.model.trim().length > 0) {
    preset.model = value.model.trim();
  }
  if (typeof value.thinking === "string" && value.thinking.trim().length > 0) {
    preset.thinking = value.thinking.trim();
  }
  const tools = readStringList(value.tools);
  if (tools) preset.tools = tools;
  if (typeof value.systemPrompt === "string" && value.systemPrompt.trim().length > 0) {
    preset.systemPrompt = value.systemPrompt.trim();
  }

  return preset;
}

function parseConfig(value: unknown): Partial<SubagentsConfig> {
  if (!isRecord(value)) return {};

  const config: Partial<SubagentsConfig> = {};

  if (typeof value.maxParallel === "number" && Number.isInteger(value.maxParallel)) {
    config.maxParallel = Math.max(1, Math.min(MAX_TASKS, value.maxParallel));
  }

  const defaultTools = readStringList(value.defaultTools);
  if (defaultTools) config.defaultTools = defaultTools;

  if (isRecord(value.agents)) {
    const agents: Record<string, WorkerPreset> = {};
    for (const [name, rawPreset] of Object.entries(value.agents)) {
      const preset = parsePreset(rawPreset);
      if (preset && name.trim().length > 0) agents[name.trim()] = preset;
    }
    config.agents = agents;
  }

  return config;
}

function mergeConfig(base: SubagentsConfig, override: Partial<SubagentsConfig>): SubagentsConfig {
  const agents: Record<string, WorkerPreset> = { ...base.agents };
  for (const [name, preset] of Object.entries(override.agents ?? {})) {
    agents[name] = { ...agents[name], ...preset };
  }

  return {
    maxParallel: override.maxParallel ?? base.maxParallel,
    defaultTools: override.defaultTools ?? base.defaultTools,
    agents,
  };
}

function loadMarkdownAgents(dir: string): Record<string, WorkerPreset> {
  const agents: Record<string, WorkerPreset> = {};
  if (!existsSync(dir)) return agents;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    const name = frontmatter.name?.trim();
    const description = frontmatter.description?.trim();
    if (!name || !description) {
      console.warn(`[subagents] Ignoring ${filePath}: markdown agents need name and description frontmatter.`);
      continue;
    }

    const preset: WorkerPreset = { description, systemPrompt: body.trim() };
    if (frontmatter.model?.trim()) preset.model = frontmatter.model.trim();
    if (frontmatter.thinking?.trim()) preset.thinking = frontmatter.thinking.trim();
    const tools = readStringList(frontmatter.tools);
    if (tools) preset.tools = tools;

    agents[name] = preset;
  }

  return agents;
}

function findProjectMarkdownAgentsDir(cwd: string): string | undefined {
  let currentDir = resolvePath(cwd);
  while (true) {
    const candidate = join(currentDir, ".agents", "agents");
    if (existsSync(candidate)) return candidate;
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return undefined;
    currentDir = parentDir;
  }
}

function readConfig(cwd: string, includeProject: boolean): SubagentsConfig {
  let config = mergeConfig(DEFAULT_CONFIG, {
    agents: loadMarkdownAgents(join(homedir(), ".agents", "agents")),
  });

  if (includeProject) {
    const projectMarkdownDir = findProjectMarkdownAgentsDir(cwd);
    if (projectMarkdownDir) {
      config = mergeConfig(config, { agents: loadMarkdownAgents(projectMarkdownDir) });
    }
  }

  const globalSettings = readJsonFile(join(getAgentDir(), "settings.json"));
  config = mergeConfig(config, parseConfig(globalSettings.subagents));

  if (includeProject) {
    const projectSettings = readJsonFile(join(cwd, CONFIG_DIR_NAME, "settings.json"));
    config = mergeConfig(config, parseConfig(projectSettings.subagents));
  }

  return config;
}

function configuredAgentSummary(config: SubagentsConfig): string {
  return Object.entries(config.agents)
    .map(([name, preset]) => {
      const model = preset.model ? ` model=${preset.model}` : " model=parent-default";
      const tools = preset.tools ? ` tools=${preset.tools.join(",")}` : "";
      const description = preset.description ? ` - ${preset.description}` : "";
      return `- ${name}:${model}${tools}${description}`;
    })
    .join("\n");
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };

  return { command: "pi", args };
}

function getFinalOutput(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content))
      continue;

    for (const part of message.content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
    }
  }

  return "";
}

function initialUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function addUsage(result: WorkerResult, message: JsonRecord) {
  if (message.role !== "assistant") return;
  result.usage.turns += 1;

  if (!isRecord(message.usage)) return;
  const usage = message.usage;
  result.usage.input += typeof usage.input === "number" ? usage.input : 0;
  result.usage.output += typeof usage.output === "number" ? usage.output : 0;
  result.usage.cacheRead += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
  result.usage.cacheWrite += typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
  result.usage.contextTokens =
    typeof usage.totalTokens === "number" ? usage.totalTokens : result.usage.contextTokens;

  if (isRecord(usage.cost) && typeof usage.cost.total === "number") {
    result.usage.cost += usage.cost.total;
  }

  if (!result.model && typeof message.model === "string") result.model = message.model;
  if (typeof message.stopReason === "string") result.stopReason = message.stopReason;
  if (typeof message.errorMessage === "string") result.errorMessage = message.errorMessage;
}

async function writePromptFile(name: string, prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-mini-subagent-"));
  const safeName = name.replace(/[^\w.-]+/g, "_");
  const path = join(dir, `${safeName}.md`);
  await writeFile(path, prompt, { encoding: "utf-8", mode: 0o600 });
  return path;
}

async function cleanupPromptFile(path: string | undefined) {
  if (!path) return;

  try {
    await rm(dirname(path), { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[subagents] Failed to remove temporary prompt ${path}: ${message}`);
  }
}

function workerHasWriteTools(task: ResolvedWorkerTask): boolean {
  return task.tools.some((tool) => WRITE_TOOLS.has(tool));
}

function resolveWorkerTask(
  input: WorkerTaskInput,
  config: SubagentsConfig,
  parentCwd: string,
): ResolvedWorkerTask {
  const preset = input.agent ? config.agents[input.agent] : undefined;
  if (input.agent && !preset) {
    const available = Object.keys(config.agents).sort().join(", ") || "none";
    throw new Error(`Unknown mini subagent "${input.agent}". Available: ${available}`);
  }

  const name = input.agent ?? input.model ?? "ad-hoc-worker";
  const tools = input.tools ?? preset?.tools ?? config.defaultTools;
  const promptParts = [
    `You are ${name}, a child Pi worker spawned by a parent orchestrator.`,
    "Work only on the delegated task. Return a concise, self-contained result the parent can use without seeing your full transcript.",
    preset?.systemPrompt,
    input.systemPrompt,
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);

  return {
    name,
    task: input.task,
    model: input.model ?? preset?.model,
    thinking: input.thinking ?? preset?.thinking,
    tools,
    systemPrompt: promptParts.join("\n\n"),
    cwd: input.cwd ? resolvePath(parentCwd, input.cwd) : parentCwd,
  };
}

async function assertDirectory(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`${path} is not a directory`);
}

async function runWorker(
  task: ResolvedWorkerTask,
  signal: AbortSignal | undefined,
): Promise<WorkerResult> {
  const result: WorkerResult = {
    name: task.name,
    task: task.task,
    model: task.model,
    thinking: task.thinking,
    tools: task.tools,
    cwd: task.cwd,
    exitCode: 0,
    messages: [],
    stderr: "",
    output: "",
    usage: initialUsage(),
  };

  let promptPath: string | undefined;

  try {
    await assertDirectory(task.cwd);
    promptPath = await writePromptFile(task.name, task.systemPrompt);

    const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", promptPath];
    if (task.model) args.push("--model", task.model);
    if (task.thinking) args.push("--thinking", task.thinking);
    if (task.tools.length === 0) args.push("--no-tools");
    else args.push("--tools", task.tools.join(","));
    args.push(`Delegated task for ${task.name}:\n\n${task.task}`);

    result.exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        cwd: task.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      let stdoutBuffer = "";
      let aborted = false;

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;

        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (!isRecord(event)) return;
        if (
          (event.type === "message_end" || event.type === "tool_result_end") &&
          isRecord(event.message)
        ) {
          result.messages.push(event.message);
          addUsage(result, event.message);
        }
      };

      child.stdout.on("data", (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      child.stderr.on("data", (data) => {
        result.stderr += data.toString();
      });

      child.on("error", (error) => {
        result.stderr += `${error.message}\n`;
        finish(1);
      });

      child.on("close", (code) => {
        if (stdoutBuffer.trim().length > 0) processLine(stdoutBuffer);
        if (aborted) {
          result.stopReason = "aborted";
          result.errorMessage = "Subagent aborted by parent signal.";
        }
        finish(code ?? 0);
      });

      const abort = () => {
        aborted = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000).unref();
      };

      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  } catch (error) {
    result.exitCode = 1;
    result.errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    await cleanupPromptFile(promptPath);
  }

  result.output = getFinalOutput(result.messages);
  return result;
}

function isFailed(result: WorkerResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function truncateOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf-8");
  if (byteLength <= OUTPUT_CAP_BYTES) return output;

  let truncated = output.slice(0, OUTPUT_CAP_BYTES);
  while (Buffer.byteLength(truncated, "utf-8") > OUTPUT_CAP_BYTES)
    truncated = truncated.slice(0, -1);
  const omitted = byteLength - Buffer.byteLength(truncated, "utf-8");
  return `${truncated}\n\n[subagents truncated ${omitted} bytes from this worker output; full output is in tool details.]`;
}

function cleanTerminalOutput(output: string): string {
  return output
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g, "")
    .trim();
}

function formatUsage(usage: UsageStats): string {
  const parts = [];
  if (usage.turns > 0) parts.push(`${usage.turns} turns`);
  if (usage.input > 0) parts.push(`in=${usage.input}`);
  if (usage.output > 0) parts.push(`out=${usage.output}`);
  if (usage.cacheRead > 0) parts.push(`cacheRead=${usage.cacheRead}`);
  if (usage.cacheWrite > 0) parts.push(`cacheWrite=${usage.cacheWrite}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" ");
}

function formatResults(results: WorkerResult[]): string {
  const succeeded = results.filter((result) => !isFailed(result)).length;
  const sections = results.map((result) => {
    const status = isFailed(result) ? "failed" : "succeeded";
    const model = result.model ? `\nmodel: ${result.model}` : "";
    const usage = formatUsage(result.usage);
    const usageLine = usage ? `\nusage: ${usage}` : "";
    const error = result.errorMessage ? `\nerror: ${result.errorMessage}` : "";
    const cleanStderr = cleanTerminalOutput(result.stderr);
    const stderr = cleanStderr ? `\nstderr:\n${cleanStderr}` : "";
    const output = truncateOutput(
      result.output || result.errorMessage || cleanStderr || "(no output)",
    );
    return `## ${result.name} ${status}${model}${usageLine}${error}${stderr}\n\n${output}`;
  });

  return `subagents: ${succeeded}/${results.length} succeeded\n\n${sections.join("\n\n---\n\n")}`;
}

async function mapWithConcurrency<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

const WorkerTask = Type.Object({
  agent: Type.Optional(
    Type.String({
      description: "Configured worker preset name, such as scout-haiku or reviewer-sonnet.",
    }),
  ),
  task: Type.String({ description: "Self-contained task to give this worker." }),
  model: Type.Optional(
    Type.String({
      description: "Override model for this worker, for example anthropic/claude-haiku-4-5.",
    }),
  ),
  thinking: Type.Optional(
    Type.String({
      description: "Optional Pi thinking level override: off, minimal, low, medium, high, xhigh.",
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), { description: "Override enabled tools for this worker." }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Additional worker-specific system prompt." }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Worker cwd. Relative paths resolve against the parent Pi cwd." }),
  ),
});

const SubagentsParams = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "Configured worker preset name for a single worker." }),
  ),
  task: Type.Optional(Type.String({ description: "Single worker task. Use tasks for fan-out." })),
  model: Type.Optional(Type.String({ description: "Single worker model override." })),
  thinking: Type.Optional(Type.String({ description: "Single worker thinking override." })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Single worker tools override." })),
  systemPrompt: Type.Optional(Type.String({ description: "Single worker extra system prompt." })),
  cwd: Type.Optional(Type.String({ description: "Single worker cwd." })),
  tasks: Type.Optional(
    Type.Array(WorkerTask, {
      description: "Parallel worker tasks. Each can choose a different agent/model.",
    }),
  ),
  concurrency: Type.Optional(Type.Number({ description: "Max concurrent workers for this call." })),
  allowParallelWrites: Type.Optional(
    Type.Boolean({
      description: "Allow multiple-task runs when any worker has edit/write tools. Default false.",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  const startupConfig = readConfig(process.cwd(), false);
  const startupAgents = configuredAgentSummary(startupConfig);

  pi.registerTool<typeof SubagentsParams, SubagentsDetails>({
    name: "subagents",
    label: "Subagents",
    description: [
      "Spawn one or more isolated Pi worker subprocesses on demand.",
      "Use this only when the user explicitly asks for subagents, delegation, orchestration, parallel workers, or a second model opinion.",
      "The current Pi session/model is the orchestrator; this tool runs child workers with their own models/tools/prompts and returns their outputs.",
      "Prefer parallel read-only scouts/reviewers/planners, then at most one write-capable worker.",
      `Configured global workers:\n${startupAgents}`,
    ].join("\n"),
    parameters: SubagentsParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = readConfig(ctx.cwd, ctx.isProjectTrusted());
      const hasSingle = typeof params.task === "string" && params.task.trim().length > 0;
      const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;

      if (Number(hasSingle) + Number(hasTasks) !== 1) {
        return {
          content: [
            {
              type: "text",
              text: `Provide exactly one of task or tasks.\n\nConfigured workers:\n${configuredAgentSummary(config)}`,
            },
          ],
          details: { results: [] },
          isError: true,
        };
      }

      const taskInputs: WorkerTaskInput[] = hasTasks
        ? params.tasks!.map((task) => ({
            agent: task.agent,
            task: task.task,
            model: task.model,
            thinking: task.thinking,
            tools: task.tools,
            systemPrompt: task.systemPrompt,
            cwd: task.cwd,
          }))
        : [
            {
              agent: params.agent,
              task: params.task!,
              model: params.model,
              thinking: params.thinking,
              tools: params.tools,
              systemPrompt: params.systemPrompt,
              cwd: params.cwd,
            },
          ];

      if (taskInputs.length > MAX_TASKS) {
        return {
          content: [
            { type: "text", text: `Too many workers: ${taskInputs.length}. Max is ${MAX_TASKS}.` },
          ],
          details: { results: [] },
          isError: true,
        };
      }

      let resolvedTasks: ResolvedWorkerTask[];
      try {
        resolvedTasks = taskInputs.map((task) => resolveWorkerTask(task, config, ctx.cwd));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: { results: [] },
          isError: true,
        };
      }

      if (
        resolvedTasks.length > 1 &&
        resolvedTasks.some(workerHasWriteTools) &&
        params.allowParallelWrites !== true
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Refusing a multi-worker run because at least one worker has edit/write tools. Run read-only workers in parallel, then run one write-capable worker, or set allowParallelWrites=true explicitly.",
            },
          ],
          details: { results: [] },
          isError: true,
        };
      }

      const requestedConcurrency =
        typeof params.concurrency === "number" && Number.isFinite(params.concurrency)
          ? Math.floor(params.concurrency)
          : config.maxParallel;
      const concurrency = Math.max(
        1,
        Math.min(config.maxParallel, requestedConcurrency, resolvedTasks.length),
      );
      const runningResults: WorkerResult[] = [];

      const emitUpdate = () => {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `subagents: ${runningResults.length}/${resolvedTasks.length} workers finished...`,
            },
          ],
          details: { results: [...runningResults] },
        });
      };

      emitUpdate();
      const results = await mapWithConcurrency(resolvedTasks, concurrency, async (task) => {
        const result = await runWorker(task, signal);
        runningResults.push(result);
        emitUpdate();
        return result;
      });

      return {
        content: [{ type: "text", text: formatResults(results) }],
        details: { results },
        isError: results.some(isFailed),
      };
    },
  });

  pi.registerCommand("orchestrate", {
    description: "Ask the current model to orchestrate work with subagents",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /orchestrate <task>", "warning");
        return;
      }

      const config = readConfig(ctx.cwd, ctx.isProjectTrusted());
      pi.sendUserMessage([
        {
          type: "text",
          text: [
            "Act as the orchestrator for this request.",
            "Use the subagents tool when useful to fan out read-only investigation, planning, or review to workers with different models.",
            "Do not spawn write-capable workers in parallel unless I explicitly ask for that.",
            "Synthesize worker outputs yourself before answering.",
            "",
            "Configured workers:",
            configuredAgentSummary(config),
            "",
            "Task:",
            task,
          ].join("\n"),
        },
      ]);
    },
  });

  pi.registerCommand("subagents", {
    description: "Show configured subagents workers",
    handler: async (_args, ctx) => {
      const config = readConfig(ctx.cwd, ctx.isProjectTrusted());
      ctx.ui.notify(`Configured subagents workers:\n${configuredAgentSummary(config)}`, "info");
    },
  });
}
