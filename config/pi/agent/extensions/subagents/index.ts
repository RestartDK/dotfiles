import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  keyHint,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { BackendRunner, instructionFiles, type Attempt, type Execution } from "./backend";
import {
  backendLabel,
  describePolicy,
  loadPolicy,
  resolveRoute,
  type Policy,
  type ResolvedRoute,
} from "../../lib/model-policy";
import { initialUsage, type UsageStats } from "./protocol";
import { authorizeSessionPolicy } from "../../lib/session-policy";
import { fleetStatus, modelLabel, renderFleet, singleLine, type FleetRun } from "./fleet";

type JsonRecord = Record<string, unknown>;

interface WorkerPreset {
  description?: string;
  role?: string;
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

type WorkerTaskInput = Static<typeof WorkerTask>;

interface ResolvedWorkerTask {
  name: string;
  label?: string;
  task: string;
  route: ResolvedRoute;
  tools: string[];
  systemPrompt: string;
  cwd: string;
  contextFiles: string[];
}

interface WorkerResult {
  name: string;
  label?: string;
  task: string;
  route: ResolvedRoute;
  attempts: Attempt[];
  actual?: Execution["actual"];
  tools: string[];
  cwd: string;
  outcome: Execution["outcome"];
  stderr: string;
  output: string;
  usage: UsageStats;
}

interface SubagentsDetails {
  results: WorkerResult[];
  runs?: RunSummary[];
}

type RunId = string & { readonly __brand: "RunId" };

interface RunAccumulator {
  usage: UsageStats;
  stderr: string;
  output: string;
  actual?: Execution["actual"];
  activity?: Execution["activity"];
  attempts: Attempt[];
}

interface RunMetadata {
  id: RunId;
  scope: "foreground" | "background";
  task: ResolvedWorkerTask;
  writeCapable: boolean;
  startedAt: number;
  abort: AbortController;
  live: RunAccumulator;
  joined: boolean;
}

interface RunningRun extends RunMetadata {
  status: "running";
  done: Promise<TerminalRun>;
}

interface TerminalRun {
  status: "completed" | "failed" | "stopped";
  id: RunId;
  scope: RunMetadata["scope"];
  task: ResolvedWorkerTask;
  writeCapable: boolean;
  startedAt: number;
  finishedAt: number;
  result: WorkerResult;
  joined: boolean;
  dismissed?: boolean;
}

type RunRecord = RunningRun | TerminalRun;

interface RunSummary {
  runId: string;
  name: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
}

const MAX_TASKS = 8;
const OUTPUT_CAP_BYTES = 50 * 1024;
const MAX_TERMINAL_RUNS = 16;
const MAX_LIVE_RUNS = 8;
const STDERR_CAP_BYTES = 16 * 1024;
const WRITE_TOOLS = new Set(["edit", "write"]);
const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash"];

const DEFAULT_CONFIG: SubagentsConfig = {
  maxParallel: 4,
  defaultTools: DEFAULT_TOOLS,
  agents: {},
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
    return strings.map((item) => item.trim());
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
  if (typeof value.role === "string" && value.role.trim().length > 0) {
    preset.role = value.role.trim();
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
      console.warn(
        `[subagents] Ignoring ${filePath}: markdown agents need name and description frontmatter.`,
      );
      continue;
    }

    const preset: WorkerPreset = { description, systemPrompt: body.trim() };
    if (frontmatter.role?.trim()) preset.role = frontmatter.role.trim();
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
      const model = preset.role
        ? ` role=${preset.role}`
        : preset.model
          ? ` model=${preset.model}`
          : " role=required";
      const tools = preset.tools ? ` tools=${preset.tools.join(",")}` : "";
      const description = preset.description ? ` - ${preset.description}` : "";
      return `- ${name}:${model}${tools}${description}`;
    })
    .join("\n");
}

function workerHasWriteTools(task: ResolvedWorkerTask): boolean {
  return task.tools.some((tool) => WRITE_TOOLS.has(tool));
}

function resolveWorkerTask(
  input: WorkerTaskInput,
  config: SubagentsConfig,
  parentCwd: string,
  policy: Policy,
): ResolvedWorkerTask {
  const preset = input.agent ? config.agents[input.agent] : undefined;
  if (input.agent && !preset) {
    const available = Object.keys(config.agents).sort().join(", ") || "none";
    throw new Error(`Unknown mini subagent "${input.agent}". Available: ${available}`);
  }

  const managed = input.agent === "dstack-agent" || input.agent === "comment-sicko";
  if (managed && input.model !== undefined)
    throw new Error("Managed dstack agents require a role, not a raw model.");
  if (input.agent === "comment-sicko" && input.role !== undefined && input.role !== "review")
    throw new Error("comment-sicko requires the review role.");
  const route = resolveRoute(policy, {
    role:
      input.agent === "comment-sicko"
        ? "review"
        : (input.role ?? (input.model === undefined ? preset?.role : undefined)),
    member: input.member,
    seat: input.seat,
    model: input.model ?? (input.role === undefined && !managed ? preset?.model : undefined),
    thinking: input.thinking ?? preset?.thinking,
  });
  const name = input.agent ?? input.role ?? input.model ?? "ad-hoc-worker";
  const tools = input.tools ?? preset?.tools ?? config.defaultTools;
  const promptParts = [
    `You are ${name}, a child worker spawned by a parent orchestrator.`,
    "Work only on the delegated task. Return a concise, self-contained result the parent can use without seeing your full transcript.",
    preset?.systemPrompt,
    input.systemPrompt,
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);

  const cwd = input.cwd ? resolvePath(parentCwd, input.cwd) : parentCwd;
  return {
    name,
    label: input.label?.trim() || undefined,
    task: input.task,
    route,
    tools,
    systemPrompt: promptParts.join("\n\n"),
    cwd,
    contextFiles: instructionFiles(cwd, getAgentDir()),
  };
}

async function assertDirectory(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`${path} is not a directory`);
}

async function runWorker(
  backendRunner: BackendRunner,
  task: ResolvedWorkerTask,
  signal: AbortSignal | undefined,
  live?: RunAccumulator,
): Promise<WorkerResult> {
  const result = await backendRunner.run(task, signal, (execution) => {
    if (live)
      Object.assign(live, {
        usage: execution.usage,
        stderr: execution.stderr,
        output: execution.output,
        actual: execution.actual,
        activity: execution.activity,
        attempts: [...execution.attempts],
      });
  });
  return {
    name: task.name,
    label: task.label,
    task: task.task,
    route: task.route,
    tools: task.tools,
    cwd: task.cwd,
    attempts: result.attempts,
    actual: result.actual,
    outcome: result.outcome,
    stderr: result.stderr,
    output: result.output,
    usage: result.usage,
  };
}

function tailCap(text: string, capBytes: number): string {
  while (Buffer.byteLength(text, "utf-8") > capBytes) text = text.slice(Math.ceil(text.length / 2));
  return text;
}

const runRegistry = new Map<RunId, RunRecord>();

const FLEET_WIDGET_KEY = "subagents-fleet";
const FLEET_VIEWS = ["panel", "status", "off"] as const;
type FleetView = (typeof FLEET_VIEWS)[number];

function isFleetView(value: unknown): value is FleetView {
  return FLEET_VIEWS.some((view) => view === value);
}

function saveFleetView(view: FleetView): void {
  const path = join(getAgentDir(), "subagents.json");
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  mkdirSync(getAgentDir(), { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify({ view }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

let fleetView: FleetView = "panel";
let fleetCtx: ExtensionContext | undefined;
let fleetTimer: ReturnType<typeof setInterval> | undefined;
let fleetRender: (() => void) | undefined;
let lastFleetStatus: string | undefined;

function newRunId(name: string): RunId {
  return `run-${name}-${randomBytes(4).toString("hex")}` as RunId;
}

function runningRuns(): RunningRun[] {
  return [...runRegistry.values()].filter((run): run is RunningRun => run.status === "running");
}

function backgroundRuns(): RunRecord[] {
  return [...runRegistry.values()].filter((run) => run.scope === "background");
}

function evictTerminalRuns() {
  for (const scope of ["foreground", "background"] as const) {
    const terminals = [...runRegistry.values()].filter(
      (run): run is TerminalRun => run.status !== "running" && run.scope === scope,
    );
    if (terminals.length <= MAX_TERMINAL_RUNS) continue;
    terminals.sort((a, b) => a.finishedAt - b.finishedAt);
    for (const run of terminals.slice(0, terminals.length - MAX_TERMINAL_RUNS)) {
      runRegistry.delete(run.id);
    }
  }
}

function transitionRun(run: RunMetadata, result: WorkerResult): TerminalRun {
  result.stderr = tailCap(result.stderr, STDERR_CAP_BYTES);
  const terminal: TerminalRun = {
    status:
      result.outcome.kind === "cancelled" ? "stopped" : isFailed(result) ? "failed" : "completed",
    id: run.id,
    scope: run.scope,
    task: run.task,
    writeCapable: run.writeCapable,
    startedAt: run.startedAt,
    finishedAt: Date.now(),
    result,
    joined: false,
  };
  runRegistry.set(run.id, terminal);
  evictTerminalRuns();
  refreshFleetWidget();
  return terminal;
}

function launchRun(
  backendRunner: BackendRunner,
  task: ResolvedWorkerTask,
  scope: RunMetadata["scope"],
  signal?: AbortSignal,
): RunningRun {
  const metadata: RunMetadata = {
    id: newRunId(task.name),
    scope,
    task,
    writeCapable: workerHasWriteTools(task),
    startedAt: Date.now(),
    abort: new AbortController(),
    live: { usage: initialUsage(), stderr: "", output: "", attempts: [] },
    joined: false,
  };
  const run: RunningRun = {
    ...metadata,
    status: "running",
    done: runWorker(
      backendRunner,
      task,
      signal ? AbortSignal.any([signal, metadata.abort.signal]) : metadata.abort.signal,
      metadata.live,
    ).then((result) => transitionRun(metadata, result)),
  };
  runRegistry.set(run.id, run);
  refreshFleetWidget();
  ensureFleetTimer();
  return run;
}

function stopRuns(ids: RunId[]): { signaled: RunId[]; alreadyTerminal: TerminalRun[] } {
  const signaled: RunId[] = [];
  const alreadyTerminal: TerminalRun[] = [];
  for (const id of ids) {
    const record = runRegistry.get(id);
    if (!record) continue;
    if (record.status === "running") {
      record.abort.abort();
      signaled.push(id);
    } else {
      alreadyTerminal.push(record);
    }
  }
  return { signaled, alreadyTerminal };
}

function parseRunIds(raw: string[]): RunId[] {
  const unknown = raw.filter((id) => runRegistry.get(id as RunId)?.scope !== "background");
  if (unknown.length > 0) {
    const known =
      backgroundRuns()
        .map((run) => run.id)
        .join(", ") || "none";
    throw new Error(`Unknown run id(s): ${unknown.join(", ")}. Known runs: ${known}.`);
  }
  return raw as RunId[];
}

async function awaitRuns(
  records: RunRecord[],
  signal: AbortSignal | undefined,
  onProgress?: (finished: number, total: number) => void,
): Promise<TerminalRun[] | "interrupted"> {
  if (signal?.aborted) return "interrupted";
  let finished = records.filter((record) => record.status !== "running").length;
  onProgress?.(finished, records.length);
  const terminals = Promise.all(
    records.map((record) => {
      if (record.status !== "running") return Promise.resolve(record);
      return record.done.then((terminal) => {
        finished += 1;
        onProgress?.(finished, records.length);
        return terminal;
      });
    }),
  );
  const interrupted = new Promise<"interrupted">((resolve) => {
    signal?.addEventListener("abort", () => resolve("interrupted"), { once: true });
  });
  return Promise.race([terminals, interrupted]);
}

function formatRunLine(record: RunRecord): string {
  const end = record.status === "running" ? Date.now() : record.finishedAt;
  const elapsed = `${Math.max(0, Math.round((end - record.startedAt) / 1000))}s`;
  const usage = record.status === "running" ? record.live.usage : record.result.usage;
  const usageText = formatUsage(usage);
  const taskText = record.task.task.replace(/\s+/g, " ").slice(0, 60);
  const execution = record.status === "running" ? record.live : record.result;
  const selection = record.task.route.selection;
  const configured =
    selection.kind === "role" ? `${selection.role}/${selection.member}` : selection.model;
  const actual = execution.actual
    ? `${execution.actual.backend}/${execution.actual.model}`
    : "pending";
  const attempts = execution.attempts
    .map((attempt) => `${backendLabel(attempt.backend)}=${attempt.kind}`)
    .join(", ");
  return `${record.id}  ${record.status}  ${elapsed}${usageText ? `  ${usageText}` : ""}  ${configured} -> ${actual} [${attempts}]  ${taskText}`;
}

function fleetRuns(): FleetRun[] {
  return [...runRegistry.values()]
    .filter(
      (run) =>
        run.status === "running" || (!run.dismissed && (!run.joined || run.status !== "completed")),
    )
    .map((run) => {
      const execution = run.status === "running" ? run.live : run.result;
      return {
        id: run.id,
        title: run.task.label ?? run.task.task,
        model: execution.actual?.model,
        activity: run.status === "running" ? run.live.activity : undefined,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.status === "running" ? undefined : run.finishedAt,
      };
    });
}

function refreshFleetWidget() {
  const ctx = fleetCtx;
  if (ctx?.hasUI !== true) return;
  const runs = fleetRuns();
  const status = fleetView === "off" ? undefined : fleetStatus(runs, ctx.ui.theme);
  if (status !== lastFleetStatus) {
    ctx.ui.setStatus(FLEET_WIDGET_KEY, status);
    lastFleetStatus = status;
  }
  if ((fleetView !== "panel" || runningRuns().length === 0) && fleetTimer) {
    clearInterval(fleetTimer);
    fleetTimer = undefined;
  }
  if (fleetView !== "panel" || runs.length === 0) {
    ctx.ui.setWidget(FLEET_WIDGET_KEY, undefined);
    fleetRender = undefined;
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.setWidget(FLEET_WIDGET_KEY, renderFleet(runs, 80, ctx.ui.theme));
    return;
  }
  if (!fleetRender) {
    ctx.ui.setWidget(FLEET_WIDGET_KEY, (tui, theme) => {
      fleetRender = () => tui.requestRender();
      return {
        render: (width) => renderFleet(fleetRuns(), width, theme),
        invalidate() {},
      };
    });
  }
  fleetRender?.();
}

function ensureFleetTimer() {
  if (fleetView !== "panel" || fleetTimer || fleetCtx?.hasUI !== true || runningRuns().length === 0)
    return;
  fleetTimer = setInterval(refreshFleetWidget, fleetCtx.mode === "tui" ? 120 : 1000);
  fleetTimer.unref();
}

function summarizeRun(record: RunRecord): RunSummary {
  return {
    runId: record.id,
    name: record.task.name,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.status === "running" ? {} : { finishedAt: record.finishedAt }),
  };
}

function isFailed(result: WorkerResult): boolean {
  return result.outcome.kind !== "success";
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
    const selection = result.route.selection;
    const model = `\nprofile: ${result.route.profile}\nconfigured: ${selection.kind === "role" ? `${selection.role}/${selection.member}` : selection.model}\nactual: ${result.actual ? `${result.actual.backend}/${result.actual.model}` : "none"}\nattempts: ${result.attempts.map((attempt) => `${backendLabel(attempt.backend)} ${attempt.kind}${attempt.kind === "cooldown" ? ` until ${new Date(attempt.until).toISOString()}` : "reason" in attempt ? ` (${attempt.reason})` : ""}`).join(" -> ")}`;
    const usage = formatUsage(result.usage);
    const usageLine = usage ? `\nusage: ${usage}` : "";
    let reason: string | undefined;
    const outcome = result.outcome;
    switch (outcome.kind) {
      case "success":
        break;
      case "cancelled":
        reason = "Cancelled by parent";
        break;
      case "failed":
      case "provider-failure":
        reason = outcome.reason;
        break;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
    const error = reason ? `\nerror: ${reason}` : "";
    const cleanStderr = cleanTerminalOutput(result.stderr);
    const stderr = cleanStderr ? `\nstderr:\n${cleanStderr}` : "";
    const output = truncateOutput(result.output || reason || cleanStderr || "(no output)");
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
      description:
        "Configured worker preset name. The tool description lists the available presets: markdown agents from ~/.agents/agents and the project's .agents/agents.",
    }),
  ),
  task: Type.String({ description: "Self-contained task to give this worker." }),
  label: Type.Optional(Type.String({ description: "Short task title for the live worker panel." })),
  role: Type.Optional(
    Type.String({ description: "Policy role. Required for managed dstack agents." }),
  ),
  member: Type.Optional(
    Type.String({ description: "Explicit panel member from the selected profile." }),
  ),
  seat: Type.Optional(
    Type.Integer({ minimum: 0, description: "Zero-based panel seat, instead of member." }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Ad-hoc allowlisted provider/model:effort, instead of role. Never overrides billing policy.",
    }),
  ),
  thinking: Type.Optional(
    Type.String({ description: "Rejected. Effort is owned by policy; do not supply." }),
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
  label: WorkerTask.properties.label,
  role: WorkerTask.properties.role,
  member: WorkerTask.properties.member,
  seat: WorkerTask.properties.seat,
  model: WorkerTask.properties.model,
  thinking: WorkerTask.properties.thinking,
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
  background: Type.Optional(
    Type.Boolean({
      description:
        "Launch workers in the background and return run handles immediately instead of blocking. Collect results later with the subagents_runs tool. Default false.",
    }),
  ),
});

const SubagentsRunsParams = Type.Object({
  action: Type.Union([Type.Literal("join"), Type.Literal("status"), Type.Literal("stop")], {
    description:
      "join: block until the runs finish and return the same report as a synchronous subagents call. status: non-blocking snapshot. stop: SIGTERM live children; safe to repeat.",
  }),
  runIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Run handles from a background subagents launch. join with no runIds joins all unjoined runs. status with no runIds covers all known runs; stop with no runIds covers all live runs.",
    }),
  ),
});

function renderWorkerResult(
  result: AgentToolResult<SubagentsDetails>,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: Theme,
) {
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (expanded) return new Text(cleanTerminalOutput(text), 0, 0);
  const results = result.details?.results ?? [];
  if (isPartial || results.length === 0) {
    const summary = singleLine(text.split("\n")[0] ?? "");
    return new Text(
      summary + theme.fg("dim", ` (${keyHint("app.tools.expand", "details")})`),
      0,
      0,
    );
  }
  const lines = results.map((worker) => {
    const failed = isFailed(worker);
    const stopped = worker.outcome.kind === "cancelled";
    const icon = stopped ? "■" : failed ? "✕" : "✓";
    const label = stopped ? "stopped" : failed ? "failed" : "done";
    const state = theme.fg(stopped ? "muted" : failed ? "error" : "success", `${icon} ${label}`);
    const model = worker.actual ? modelLabel(worker.actual.model) : "not started";
    const reason =
      "reason" in worker.outcome ? `\n  ${singleLine(worker.outcome.reason).slice(0, 180)}` : "";
    return `${state} ${singleLine(worker.label ?? worker.name)} ${theme.fg("muted", model)}${reason}`;
  });
  lines.push(theme.fg("dim", keyHint("app.tools.expand", "reports and diagnostics")));
  return new Text(lines.join("\n"), 0, 0);
}

export default function (pi: ExtensionAPI) {
  const backendRunner = new BackendRunner();
  const startupConfig = readConfig(process.cwd(), false);
  const startupAgents = configuredAgentSummary(startupConfig);

  pi.on("session_start", (_event, ctx) => {
    const saved = readJsonFile(join(getAgentDir(), "subagents.json")).view;
    fleetView = isFleetView(saved) ? saved : "panel";
    fleetCtx = ctx.hasUI ? ctx : undefined;
    refreshFleetWidget();
    ensureFleetTimer();
  });

  pi.registerTool<typeof SubagentsParams, SubagentsDetails>({
    name: "subagents",
    label: "Subagents",
    description: [
      "Spawn isolated workers using the host's global billing profile and role routes.",
      "Managed dstack agents must select role, never model. Panels require member or zero-based seat. Thinking overrides are rejected.",
      "Claude subscription workers provide mapped built-in tools only, without Pi extensions or MCP. Unsupported tools block dispatch. Output is bounded to 50 KiB.",
      describePolicy(),
      "Use this only when the user explicitly asks for subagents, delegation, orchestration, parallel workers, or a second model opinion.",
      "The current Pi session/model is the orchestrator; this tool runs child workers with their own models/tools/prompts and returns their outputs.",
      "Prefer parallel read-only scouts/reviewers/planners, then at most one write-capable worker.",
      "With background=true every worker starts immediately and the call returns run handles right away; collect results later with the subagents_runs tool (join, status, stop).",
      `Configured global workers:\n${startupAgents}`,
    ].join("\n"),
    parameters: SubagentsParams,
    renderCall(args, theme) {
      const count = args.tasks?.length ?? 1;
      const label = args.label ? ` · ${singleLine(args.label)}` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("Subagents")) +
          theme.fg(
            "muted",
            ` ${count} worker${count === 1 ? "" : "s"}${args.background ? " · background" : ""}${label}`,
          ),
        0,
        0,
      );
    },
    renderResult: renderWorkerResult,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const policy = loadPolicy();
      authorizeSessionPolicy(ctx.sessionManager, policy.profile);
      if (ctx.hasUI) fleetCtx = ctx;
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

      if (
        hasTasks &&
        [
          params.agent,
          params.label,
          params.role,
          params.member,
          params.seat,
          params.model,
          params.thinking,
          params.tools,
          params.systemPrompt,
          params.cwd,
        ].some((value) => value !== undefined)
      )
        throw new Error("With tasks, put every worker selector and override on its task entry.");

      const taskInputs: WorkerTaskInput[] = hasTasks
        ? (params.tasks ?? []).map((task) => ({
            agent: task.agent,
            label: task.label,
            task: task.task,
            role: task.role,
            member: task.member,
            seat: task.seat,
            model: task.model,
            thinking: task.thinking,
            tools: task.tools,
            systemPrompt: task.systemPrompt,
            cwd: task.cwd,
          }))
        : [
            {
              agent: params.agent,
              label: params.label,
              task: params.task ?? "",
              role: params.role,
              member: params.member,
              seat: params.seat,
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
        resolvedTasks = taskInputs.map((task) => resolveWorkerTask(task, config, ctx.cwd, policy));
        await Promise.all(resolvedTasks.map((task) => assertDirectory(task.cwd)));
        if (signal?.aborted) throw new Error("Subagent dispatch cancelled before launch.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: { results: [] },
          isError: true,
        };
      }

      if (resolvedTasks.some(workerHasWriteTools) && params.allowParallelWrites !== true) {
        const blocking = runningRuns().find((run) => run.writeCapable);
        if (blocking) {
          return {
            content: [
              {
                type: "text",
                text: `Refusing to launch a write-capable worker while run ${blocking.id} (${blocking.task.name}) is still running. Wait for it to finish, or set allowParallelWrites=true explicitly.`,
              },
            ],
            details: { results: [] },
            isError: true,
          };
        }
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

      if (params.background === true) {
        const live = backgroundRuns().filter((run) => run.status === "running");
        if (live.length + resolvedTasks.length > MAX_LIVE_RUNS) {
          return {
            content: [
              {
                type: "text",
                text: `Refusing background launch: ${live.length} live run(s) plus ${resolvedTasks.length} new would exceed the max of ${MAX_LIVE_RUNS}. Live runs: ${live.map((run) => run.id).join(", ")}.`,
              },
            ],
            details: { results: [] },
            isError: true,
          };
        }

        const runs = resolvedTasks.map((task) => launchRun(backendRunner, task, "background"));
        const lines = runs.map(
          (run) => `- ${run.id}: ${run.task.task.replace(/\s+/g, " ").slice(0, 80)}`,
        );
        return {
          content: [
            {
              type: "text",
              text: `Launched ${runs.length} background run${runs.length === 1 ? "" : "s"}. All children are running now.\n${lines.join("\n")}\nJoin with subagents_runs { action: "join", runIds: [...] }.`,
            },
          ],
          details: { results: [], runs: runs.map(summarizeRun) },
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
      const completed = await mapWithConcurrency(resolvedTasks, concurrency, async (task) => {
        const terminal = await launchRun(backendRunner, task, "foreground", signal).done;
        runningResults.push(terminal.result);
        emitUpdate();
        return terminal;
      });
      for (const terminal of completed) terminal.joined = true;
      refreshFleetWidget();
      const results = completed.map((terminal) => terminal.result);

      return {
        content: [{ type: "text", text: formatResults(results) }],
        details: { results },
        isError: results.some(isFailed),
      };
    },
  });

  pi.registerTool<typeof SubagentsRunsParams, SubagentsDetails>({
    name: "subagents_runs",
    label: "Subagent Runs",
    description: [
      "Manage background runs launched by the subagents tool with background=true.",
      "join blocks until the given runs (or all unjoined runs when runIds is omitted) reach a terminal state and returns the same per-worker report as a synchronous subagents call; interrupting a join detaches and the children keep running.",
      "status returns a non-blocking snapshot with live usage counters.",
      "stop SIGTERMs the live children of the given runs (all live runs when runIds is omitted); it is idempotent and reports already-terminal runs.",
    ].join("\n"),
    parameters: SubagentsRunsParams,
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("Subagents")) + theme.fg("muted", ` ${args.action ?? ""}`),
        0,
        0,
      );
    },
    renderResult: renderWorkerResult,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (ctx.hasUI) fleetCtx = ctx;
      if (params.action === "status") {
        let records = backgroundRuns();
        if (params.runIds && params.runIds.length > 0) {
          try {
            records = parseRunIds(params.runIds).map((id) => runRegistry.get(id)!);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text", text: message }],
              details: { results: [] },
              isError: true,
            };
          }
        }
        refreshFleetWidget();
        ensureFleetTimer();
        const text =
          records.length > 0 ? records.map(formatRunLine).join("\n") : "No background runs.";
        return {
          content: [{ type: "text", text }],
          details: { results: [], runs: records.map(summarizeRun) },
        };
      }

      if (params.action === "stop") {
        let ids: RunId[];
        try {
          ids =
            params.runIds && params.runIds.length > 0
              ? parseRunIds(params.runIds)
              : backgroundRuns()
                  .filter((run) => run.status === "running")
                  .map((run) => run.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: message }],
            details: { results: [] },
            isError: true,
          };
        }
        if (ids.length === 0) {
          return {
            content: [{ type: "text", text: "No live background runs to stop." }],
            details: { results: [] },
          };
        }
        const { signaled, alreadyTerminal } = stopRuns(ids);
        refreshFleetWidget();
        ensureFleetTimer();
        const lines = [
          ...signaled.map((id) => `${id}: SIGTERM sent (was running).`),
          ...alreadyTerminal.map((run) => `${run.id}: already terminal (${run.status}).`),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }], details: { results: [] } };
      }

      let records: RunRecord[];
      try {
        const ids =
          params.runIds && params.runIds.length > 0
            ? parseRunIds(params.runIds)
            : backgroundRuns()
                .filter((run) => !run.joined)
                .map((run) => run.id);
        records = ids.map((id) => runRegistry.get(id)!);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          details: { results: [] },
          isError: true,
        };
      }

      if (records.length === 0) {
        refreshFleetWidget();
        ensureFleetTimer();
        return {
          content: [{ type: "text", text: "No unjoined background runs." }],
          details: { results: [] },
        };
      }

      const outcome = await awaitRuns(records, signal, (finished, total) => {
        onUpdate?.({
          content: [
            { type: "text", text: `subagents_runs: ${finished}/${total} runs finished...` },
          ],
          details: { results: [], runs: records.map(summarizeRun) },
        });
      });

      if (outcome === "interrupted") {
        refreshFleetWidget();
        ensureFleetTimer();
        return {
          content: [
            {
              type: "text",
              text: `Join interrupted; detached. The children keep running. Join again or stop them with subagents_runs.\n\n${records.map(formatRunLine).join("\n")}`,
            },
          ],
          details: { results: [], runs: records.map(summarizeRun) },
        };
      }

      for (const terminal of outcome) terminal.joined = true;
      refreshFleetWidget();
      ensureFleetTimer();
      const results = outcome.map((terminal) => terminal.result);
      return {
        content: [{ type: "text", text: formatResults(results) }],
        details: { results },
        isError: results.some(isFailed),
      };
    },
  });

  pi.on("session_shutdown", async () => {
    backendRunner.stop();
    for (const run of runningRuns()) run.abort.abort();
    await Promise.all(runningRuns().map((run) => run.done));
    if (fleetTimer) {
      clearInterval(fleetTimer);
      fleetTimer = undefined;
    }
    if (fleetCtx?.hasUI) {
      fleetCtx.ui.setWidget(FLEET_WIDGET_KEY, undefined);
      fleetCtx.ui.setStatus(FLEET_WIDGET_KEY, undefined);
    }
    runRegistry.clear();
    fleetRender = undefined;
    lastFleetStatus = undefined;
    fleetCtx = undefined;
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
            describePolicy(),
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
    description: "Worker details; clear finished rows; view panel|status|off (saved)",
    getArgumentCompletions(prefix) {
      return ["clear", ...FLEET_VIEWS.map((view) => `view ${view}`)]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      if (ctx.hasUI) fleetCtx = ctx;
      const [command, view, ...extra] = args.trim().split(/\s+/);
      if (command === "view") {
        if (view === undefined) {
          ctx.ui.notify(
            `Subagent view: ${fleetView}. Use /subagents view panel|status|off.`,
            "info",
          );
          return;
        }
        if (!isFleetView(view) || extra.length > 0) {
          ctx.ui.notify("Usage: /subagents view panel|status|off", "warning");
          return;
        }
        fleetView = view;
        refreshFleetWidget();
        ensureFleetTimer();
        try {
          saveFleetView(view);
          ctx.ui.notify(`Subagent view: ${view}`, "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(
            `Subagent view: ${view} (session only; could not save: ${message})`,
            "warning",
          );
        }
        return;
      }
      if (args.trim() === "clear") {
        for (const run of runRegistry.values()) {
          if (run.status !== "running") run.dismissed = true;
        }
        refreshFleetWidget();
        return;
      }
      const config = readConfig(ctx.cwd, ctx.isProjectTrusted());
      const records = [...runRegistry.values()];
      const liveText =
        records.length > 0 ? `\n\nWorker runs:\n${records.map(formatRunLine).join("\n")}` : "";
      ctx.ui.notify(
        `${describePolicy()}\n\nConfigured subagents workers:\n${configuredAgentSummary(config)}${liveText}`,
        "info",
      );
    },
  });
}
