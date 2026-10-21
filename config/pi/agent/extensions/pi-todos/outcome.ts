import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import {
  digest,
  executable,
  fingerprint,
  runProcess,
  type Execution,
  type ProcessResult,
} from "./outcome-runner.ts";
import type { TodoEntry } from "./model.ts";

export const OUTCOME_ENTRY = "dstack-outcome-v1";
export type Expectation =
  | { kind: "equals"; value: string }
  | {
      kind: "metric";
      baseline: number;
      direction: "lower" | "higher";
      target: number;
      unit: string;
    };
export type Criterion = {
  id: string;
  claim: string;
  command: [string, ...string[]];
  timeoutMs: number;
  verifierInputs: string[];
  expect: Expectation;
};
export type Contract = {
  request: string;
  scope: string;
  inputs: string[];
  targets: string[];
  criteria: Criterion[];
};
type Attempt =
  | { kind: "unproved" }
  | { kind: "blocked"; reason: string }
  | { kind: "receipt"; id: string };
export type Outcome =
  | { version: 1; kind: "empty" }
  | {
      version: 1;
      kind: "active";
      id: string;
      revision: number;
      workspace: string;
      contract: Contract;
      digest: string;
      verifier: string;
      attempt: Attempt;
    };
type ActiveOutcome = Extract<Outcome, { kind: "active" }>;
type Observation = { kind: "text"; value: string } | { kind: "metric"; value: number };
type Check = {
  criterion: string;
  command: [string, ...string[]];
  executableHash: string;
  execution: Execution;
};
type Receipt = {
  version: 1;
  outcome: string;
  revision: number;
  contractDigest: string;
  workspace: string;
  before: string;
  after: string;
  environment: string;
  completion: "complete" | "cancelled";
  checks: Check[];
};
export type ProofFailure =
  | {
      kind:
        | "no-contract"
        | "no-proof"
        | "wrong-workspace"
        | "verifier-changed"
        | "cancelled"
        | "identity-mismatch"
        | "stale-inputs"
        | "environment-changed"
        | "incomplete-coverage"
        | "execution-bound"
        | "log-mismatch";
    }
  | { kind: "blocked"; reason: string }
  | { kind: "process-failed"; criterion: string; result: ProcessResult }
  | { kind: "expectation-missed"; criterion: string; expected: Expectation; observed: Observation };
const checkedProof = Symbol("checked-outcome-proof");
export type ProofStatus =
  | {
      readonly [checkedProof]: true;
      kind: "verified";
      receipt: string;
      coverage: string[];
      scope: string;
    }
  | { kind: "not-verified"; reason: ProofFailure };
export class OutcomeParseError extends Error {
  constructor(
    readonly kind: "shape" | "range" | "variant" | "identity",
    message: string,
  ) {
    super(message);
    this.name = "OutcomeParseError";
  }
}
export type OutcomeAction =
  | { action: "begin" | "amend"; contract: Contract }
  | { action: "prove" | "status" | "clear" }
  | { action: "block"; reason: string };

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new OutcomeParseError("shape", "Expected an outcome object");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new OutcomeParseError("shape", "Expected a string");
  return value;
}
function text(value: unknown): string {
  const parsed = string(value);
  if (parsed.trim() === "") throw new OutcomeParseError("range", "Expected non-empty text");
  return parsed;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new OutcomeParseError("shape", "Expected finite number");
  return value;
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new OutcomeParseError("range", `Expected integer in ${minimum}..${maximum}`);
  return parsed;
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new OutcomeParseError("shape", "Expected an array");
  return value.map(parse);
}
function command(value: unknown): [string, ...string[]] {
  if (!Array.isArray(value)) throw new Error("Expected command argv");
  const [first, ...rest] = value;
  if (typeof first !== "string" || first.trim() === "" || first.includes("\0"))
    throw new Error("Command needs executable");
  return [
    first,
    ...rest.map((arg: unknown) => {
      if (typeof arg !== "string" || arg.includes("\0"))
        throw new Error("Invalid command argument");
      return arg;
    }),
  ];
}
function path(value: unknown): string {
  const parsed = text(value);
  const normalized = normalize(parsed);
  if (
    isAbsolute(parsed) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    parsed.includes("\0")
  )
    throw new Error("Declare workspace-relative paths");
  return normalized;
}
function unique(values: string[]): string[] {
  if (values.length === 0 || new Set(values).size !== values.length)
    throw new Error("Coverage needs non-empty, unique entries");
  return values;
}
function expectation(value: unknown): Expectation {
  const data = object(value);
  if (data.kind === "equals") return { kind: "equals", value: text(data.value) };
  if (data.kind !== "metric" || (data.direction !== "lower" && data.direction !== "higher"))
    throw new Error("Unknown outcome expectation");
  const baseline = number(data.baseline);
  const target = number(data.target);
  if (data.direction === "lower" ? target >= baseline : target <= baseline)
    throw new Error("Metric target must improve on baseline");
  return { kind: "metric", baseline, target, direction: data.direction, unit: text(data.unit) };
}
export function parseContract(value: unknown): Contract {
  const data = object(value);
  const criteria = list(data.criteria, (item): Criterion => {
    const row = object(item);
    const id = text(row.id);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("Invalid criterion id");
    return {
      id,
      claim: text(row.claim),
      command: command(row.command),
      timeoutMs: integer(row.timeoutMs, 1, 120000),
      verifierInputs: unique(list(row.verifierInputs, path)),
      expect: expectation(row.expect),
    };
  });
  unique(criteria.map((criterion) => criterion.id));
  if (criteria.length > 16) throw new Error("At most 16 criteria per bounded proof");
  return {
    request: text(data.request),
    scope: text(data.scope),
    inputs: unique(list(data.inputs, path)),
    targets: unique(list(data.targets, path)),
    criteria,
  };
}
function contractDigest(contract: Contract): string {
  const criteria = contract.criteria.map((criterion): Criterion => {
    const expected = criterion.expect;
    let expect: Expectation;
    switch (expected.kind) {
      case "equals":
        expect = { kind: "equals", value: expected.value };
        break;
      case "metric":
        expect = {
          kind: "metric",
          baseline: expected.baseline,
          target: expected.target,
          direction: expected.direction,
          unit: expected.unit,
        };
        break;
      default: {
        const exhaustive: never = expected;
        return exhaustive;
      }
    }
    return {
      id: criterion.id,
      claim: criterion.claim,
      command: criterion.command,
      timeoutMs: criterion.timeoutMs,
      verifierInputs: criterion.verifierInputs,
      expect,
    };
  });
  const canonical: Contract = {
    request: contract.request,
    scope: contract.scope,
    inputs: contract.inputs,
    targets: contract.targets,
    criteria,
  };
  return digest(JSON.stringify(canonical));
}
export function parseOutcomeAction(value: unknown): OutcomeAction {
  const data = object(value);
  switch (data.action) {
    case "begin":
    case "amend":
      return { action: data.action, contract: parseContract(data.contract) };
    case "prove":
    case "status":
    case "clear":
      return { action: data.action };
    case "block":
      return { action: "block", reason: text(data.reason) };
    default:
      throw new OutcomeParseError("variant", "Unknown outcome action");
  }
}
function parseAttempt(value: unknown): Attempt {
  const data = object(value);
  switch (data.kind) {
    case "unproved":
      return { kind: "unproved" };
    case "blocked":
      return { kind: "blocked", reason: text(data.reason) };
    case "receipt":
      return { kind: "receipt", id: receiptId(data.id) };
    default:
      throw new OutcomeParseError("variant", "Unknown saved proof attempt");
  }
}
function receiptId(value: unknown): string {
  const id = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
    throw new Error("Invalid private receipt id");
  return id;
}
export function parseOutcome(value: unknown): Outcome {
  const data = object(value);
  if (data.version !== 1) throw new Error("Unsupported outcome version");
  if (data.kind === "empty") return { version: 1, kind: "empty" };
  if (data.kind !== "active") throw new Error("Invalid outcome lifecycle");
  const contract = parseContract(data.contract);
  if (data.digest !== contractDigest(contract))
    throw new OutcomeParseError("identity", "Changed outcome contract");
  return {
    version: 1,
    kind: "active",
    id: receiptId(data.id),
    revision: integer(data.revision, 1),
    workspace: text(data.workspace),
    contract,
    digest: data.digest,
    verifier: text(data.verifier),
    attempt: parseAttempt(data.attempt),
  };
}
export function restoreOutcome(branch: readonly TodoEntry[]): Outcome {
  const entry = branch.findLast(
    (entry) => entry.type === "custom" && entry.customType === OUTCOME_ENTRY,
  );
  return entry ? parseOutcome(entry.data) : { version: 1, kind: "empty" };
}
export async function freezeOutcome(
  current: Outcome,
  action: Extract<OutcomeAction, { contract: Contract }>,
  cwd: string,
): Promise<ActiveOutcome> {
  if (action.action === "begin" && current.kind !== "empty")
    throw new Error("Use amend for an existing outcome");
  if (action.action === "amend" && current.kind === "empty")
    throw new Error("Begin an outcome first");
  return {
    version: 1,
    kind: "active",
    id: current.kind === "active" ? current.id : randomUUID(),
    revision: current.kind === "active" ? current.revision + 1 : 1,
    workspace: await realpath(cwd),
    contract: action.contract,
    digest: contractDigest(action.contract),
    verifier: await verifierFingerprint(action.contract, cwd),
    attempt: { kind: "unproved" },
  };
}
function environment(): string {
  return digest(
    JSON.stringify({
      runtime: process.version,
      platform: process.platform,
      arch: process.arch,
      env: Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)),
    }),
  );
}
function parseResult(value: unknown): ProcessResult {
  const data = object(value);
  switch (data.kind) {
    case "exit":
      return { kind: "exit", code: integer(data.code, -1) };
    case "signal":
      return { kind: "signal", signal: text(data.signal) };
    case "timeout":
    case "cancelled":
    case "output-limit":
      return { kind: data.kind };
    case "spawn-error":
      return { kind: "spawn-error", message: text(data.message) };
    default:
      throw new OutcomeParseError("variant", "Invalid saved process result");
  }
}
function parseReceipt(value: unknown): Receipt {
  const data = object(value);
  if (data.version !== 1) throw new Error("Unsupported proof receipt");
  if (data.completion !== "complete" && data.completion !== "cancelled")
    throw new Error("Missing proof completion cause");
  return {
    version: 1,
    outcome: receiptId(data.outcome),
    revision: integer(data.revision, 1),
    contractDigest: text(data.contractDigest),
    workspace: text(data.workspace),
    before: text(data.before),
    after: text(data.after),
    environment: text(data.environment),
    completion: data.completion,
    checks: list(data.checks, (item): Check => {
      const check = object(item);
      const execution = object(check.execution);
      const started = integer(execution.started, 0);
      const finished = integer(execution.finished, started);
      return {
        criterion: text(check.criterion),
        command: command(check.command),
        executableHash: text(check.executableHash),
        execution: {
          result: parseResult(execution.result),
          started,
          finished,
          stdout: string(execution.stdout),
          stdoutHash: text(execution.stdoutHash),
          stderrHash: text(execution.stderrHash),
        },
      };
    }),
  };
}
export function parseObservation(stdout: string): Observation {
  if (Buffer.byteLength(stdout) > 65536) throw new Error("Checker observation exceeds 64 KiB");
  const value: unknown = JSON.parse(stdout);
  const data = object(value);
  if (Object.keys(data).sort().join(",") !== "kind,value")
    throw new Error("Unexpected observation fields");
  switch (data.kind) {
    case "text":
      return { kind: "text", value: text(data.value) };
    case "metric":
      return { kind: "metric", value: number(data.value) };
    default:
      throw new Error("Checker must emit {kind:'text'|'metric',value:...} JSON");
  }
}
function meets(expect: Expectation, observation: Observation): boolean {
  switch (expect.kind) {
    case "equals":
      return observation.kind === "text" && observation.value === expect.value;
    case "metric":
      return (
        observation.kind === "metric" &&
        (expect.direction === "lower"
          ? observation.value <= expect.target
          : observation.value >= expect.target)
      );
    default: {
      const exhaustive: never = expect;
      return exhaustive;
    }
  }
}
const defaultStore = () =>
  join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "outcome-proofs");
async function privateStore(store: string): Promise<void> {
  await mkdir(store, { recursive: true, mode: 0o700 });
  if ((await lstat(store)).isSymbolicLink()) throw new Error("Proof store must not be a symlink");
  await chmod(store, 0o700);
}
async function verifierFingerprint(contract: Contract, workspace: string): Promise<string> {
  const identities: string[] = [];
  for (const criterion of contract.criteria) {
    const binary = await executable(criterion.command[0], workspace);
    identities.push(binary, digest(await readFile(binary)));
    for (const input of criterion.verifierInputs) await lstat(resolve(workspace, input));
    identities.push(await fingerprint(workspace, criterion.verifierInputs));
  }
  return digest(JSON.stringify(identities));
}
async function inputs(outcome: ActiveOutcome): Promise<string> {
  return fingerprint(outcome.workspace, [
    ...new Set([
      ...outcome.contract.inputs,
      ...outcome.contract.targets,
      ...outcome.contract.criteria.flatMap((criterion) => criterion.verifierInputs),
    ]),
  ]);
}
export async function proveOutcome(
  outcome: ActiveOutcome,
  signal?: AbortSignal,
  store = defaultStore(),
): Promise<ActiveOutcome> {
  if (outcome.verifier !== (await verifierFingerprint(outcome.contract, outcome.workspace)))
    throw new Error("Frozen verifier changed. Amend the contract before proof.");
  await privateStore(store);
  const id = randomUUID();
  const before = await inputs(outcome);
  const env = environment();
  const checks: Check[] = [];
  for (const criterion of outcome.contract.criteria) {
    if (signal?.aborted) break;
    const binary = await executable(criterion.command[0], outcome.workspace);
    const argv: [string, ...string[]] = [binary, ...criterion.command.slice(1)];
    const executableHash = digest(await readFile(binary));
    const execution = await runProcess({
      command: argv,
      cwd: outcome.workspace,
      timeoutMs: criterion.timeoutMs,
      logPrefix: join(store, `${id}-${criterion.id}`),
      signal,
    });
    checks.push({ criterion: criterion.id, command: argv, executableHash, execution });
    if (execution.result.kind !== "exit" || execution.result.code !== 0) break;
  }
  const receipt: Receipt = {
    version: 1,
    outcome: outcome.id,
    revision: outcome.revision,
    contractDigest: outcome.digest,
    workspace: outcome.workspace,
    before,
    after: await inputs(outcome),
    environment: env,
    completion: signal?.aborted ? "cancelled" : "complete",
    checks,
  };
  await writeFile(join(store, `${id}.json`), JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
  return { ...outcome, attempt: { kind: "receipt", id } };
}
export async function outcomeStatus(
  outcome: Outcome,
  cwd: string,
  store = defaultStore(),
): Promise<ProofStatus> {
  const no = (reason: ProofFailure): ProofStatus => ({ kind: "not-verified", reason });
  if (outcome.kind === "empty") return no({ kind: "no-contract" });
  if (outcome.attempt.kind !== "receipt")
    return no(
      outcome.attempt.kind === "blocked"
        ? { kind: "blocked", reason: outcome.attempt.reason }
        : { kind: "no-proof" },
    );
  if ((await realpath(cwd)) !== outcome.workspace) return no({ kind: "wrong-workspace" });
  if (outcome.verifier !== (await verifierFingerprint(outcome.contract, outcome.workspace)))
    return no({ kind: "verifier-changed" });
  const id = outcome.attempt.id;
  const raw: unknown = JSON.parse(await readFile(join(store, `${id}.json`), "utf8"));
  const receipt = parseReceipt(raw);
  if (receipt.completion === "cancelled") return no({ kind: "cancelled" });
  if (
    receipt.outcome !== outcome.id ||
    receipt.revision !== outcome.revision ||
    receipt.contractDigest !== outcome.digest ||
    receipt.workspace !== outcome.workspace
  )
    return no({ kind: "identity-mismatch" });
  if (receipt.before !== receipt.after || receipt.after !== (await inputs(outcome)))
    return no({ kind: "stale-inputs" });
  if (receipt.environment !== environment()) return no({ kind: "environment-changed" });
  if (receipt.checks.length !== outcome.contract.criteria.length)
    return no({ kind: "incomplete-coverage" });
  for (const [index, criterion] of outcome.contract.criteria.entries()) {
    const check = receipt.checks[index];
    if (!check || check.criterion !== criterion.id) return no({ kind: "incomplete-coverage" });
    const binary = await executable(criterion.command[0], outcome.workspace);
    if (
      JSON.stringify(check.command) !== JSON.stringify([binary, ...criterion.command.slice(1)]) ||
      check.executableHash !== digest(await readFile(binary))
    )
      return no({ kind: "verifier-changed" });
    const execution = check.execution;
    if (execution.result.kind !== "exit" || execution.result.code !== 0)
      return no({ kind: "process-failed", criterion: criterion.id, result: execution.result });
    if (execution.finished - execution.started > criterion.timeoutMs + 1000)
      return no({ kind: "execution-bound" });
    const stdout = await readFile(join(store, `${id}-${criterion.id}.stdout`));
    const stderr = await readFile(join(store, `${id}-${criterion.id}.stderr`));
    if (
      digest(stdout) !== execution.stdoutHash ||
      digest(stderr) !== execution.stderrHash ||
      stdout.toString("utf8") !== execution.stdout
    )
      return no({ kind: "log-mismatch" });
    const observed = parseObservation(execution.stdout);
    if (!meets(criterion.expect, observed))
      return no({
        kind: "expectation-missed",
        criterion: criterion.id,
        expected: criterion.expect,
        observed,
      });
  }
  for (const target of outcome.contract.targets) await lstat(resolve(outcome.workspace, target));
  return {
    [checkedProof]: true,
    kind: "verified",
    receipt: id,
    coverage: outcome.contract.criteria.map((criterion) => criterion.id),
    scope: outcome.contract.scope,
  };
}

export class OutcomeQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
