import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type NativeProvider = "openai" | "openai-codex" | "anthropic" | "fireworks" | "openrouter";
export interface NativeTarget {
  kind: "pi";
  provider: NativeProvider;
  id: string;
  thinking: Effort;
}
export type Backend = NativeTarget | { kind: "claude-cli"; model: string; thinking: "xhigh" };
export type Chain = [Backend, ...Backend[]];
type Role = { kind: "single"; route: string } | { kind: "panel"; members: [string, ...string[]] };
export interface Policy {
  profile: "work" | "personal";
  parent: NativeTarget;
  routes: Map<string, Chain>;
  roles: Map<string, Role>;
}
export interface SelectionInput {
  role?: string;
  member?: string;
  seat?: number;
  model?: string;
  thinking?: string;
}
export interface ResolvedRoute {
  profile: Policy["profile"];
  selection: { kind: "role"; role: string; member: string } | { kind: "raw"; model: string };
  chain: Chain;
}

const requiredRoles = [
  "feature",
  "refactoring",
  "swarm-workers",
  "bug-fix",
  "perf-issue",
  "hillclimb",
  "fast-code",
  "precise-code",
  "prose",
  "judgment",
  "review",
  "hardest",
  "how-explorer",
  "how-explainer",
  "how-critics",
  "why-investigators",
  "why-synthesizer",
  "reflect-judgment",
  "reflect-tooling",
  "reflect-divergent",
  "reflect-synthesizer",
  "arena-runners",
  "arena-cross-judge",
  "architect-runners",
  "interrogate-reviewers",
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new Error(`Invalid dstack model policy: ${message}`);
}

export function parseEffort(value: unknown): Effort {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      return invalid("unsupported thinking level");
  }
}

function parseNativeProvider(value: string): NativeProvider {
  switch (value) {
    case "openai":
    case "openai-codex":
    case "anthropic":
    case "fireworks":
    case "openrouter":
      return value;
    default:
      return invalid("unsupported native Pi provider");
  }
}

function parseBackend(value: unknown, profile: Policy["profile"]): Backend {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["kind", "model", "thinking"].includes(key)) ||
    typeof value.model !== "string" ||
    typeof value.thinking !== "string"
  ) {
    return invalid("backend needs kind, model and thinking");
  }
  if (
    value.kind === "claude-cli" &&
    value.model === "claude-fable-5-1" &&
    value.thinking === "xhigh"
  ) {
    return { kind: value.kind, model: value.model, thinking: value.thinking };
  }
  if (value.kind !== "pi" || !/^[a-z0-9-]+\/[^\s:]+$/.test(value.model)) {
    return invalid("unsupported backend, model or thinking");
  }
  if (
    profile === "personal" &&
    !["openai-codex/gpt-6-astra", "openrouter/deepseek/deepseek-v4.1-flash"].includes(value.model)
  ) {
    return invalid("personal profile forbids this API route");
  }
  const separator = value.model.indexOf("/");
  return {
    kind: "pi",
    provider: parseNativeProvider(value.model.slice(0, separator)),
    id: value.model.slice(separator + 1),
    thinking: parseEffort(value.thinking),
  };
}

export function parsePolicy(value: unknown): Policy {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["version", "profile", "parent", "routes", "roles"].includes(key),
    ) ||
    value.version !== 1 ||
    (value.profile !== "work" && value.profile !== "personal") ||
    typeof value.parent !== "string" ||
    !isRecord(value.routes) ||
    !isRecord(value.roles)
  )
    return invalid("expected version 1, profile, parent route, routes and roles");
  const profile = value.profile;
  const routes = new Map<string, Chain>();
  for (const [name, raw] of Object.entries(value.routes)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !Array.isArray(raw) || raw.length > 4)
      return invalid(`route ${name}`);
    const parsed = raw.map((entry: unknown) => parseBackend(entry, profile));
    const [first, ...rest] = parsed;
    if (
      !first ||
      new Set(parsed.map((backend) => `${backend.kind}/${backendModel(backend)}`)).size !==
        parsed.length
    )
      return invalid(`empty or duplicate route ${name}`);
    routes.set(name, [first, ...rest]);
  }
  const roles = new Map<string, Role>();
  for (const [name, raw] of Object.entries(value.roles)) {
    if (
      !isRecord(raw) ||
      Object.keys(raw).some(
        (key) => !["kind", raw.kind === "single" ? "route" : "members"].includes(key),
      )
    )
      return invalid(`role ${name}`);
    if (raw.kind === "single" && typeof raw.route === "string" && routes.has(raw.route)) {
      roles.set(name, { kind: "single", route: raw.route });
    } else if (raw.kind === "panel" && Array.isArray(raw.members)) {
      const members: string[] = [];
      for (const member of raw.members) {
        if (typeof member !== "string" || !routes.has(member) || members.includes(member))
          return invalid(`panel ${name}`);
        members.push(member);
      }
      const [first, ...rest] = members;
      if (!first) return invalid(`empty panel ${name}`);
      roles.set(name, { kind: "panel", members: [first, ...rest] });
    } else return invalid(`role ${name} has no valid route`);
  }
  for (const role of requiredRoles) if (!roles.has(role)) return invalid(`missing role ${role}`);
  const parentChain = routes.get(value.parent);
  if (!parentChain || parentChain.length !== 1 || parentChain[0].kind !== "pi")
    return invalid(
      "parent must reference one native Pi target, never Claude Code or a fallback chain",
    );
  return { profile, parent: parentChain[0], routes, roles };
}

export function loadPolicy(
  configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
): Policy {
  const path = join(configHome, "dstack/models.json");
  try {
    if (!isAbsolute(configHome)) return invalid("XDG_CONFIG_HOME must be absolute");
    return parsePolicy(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(
      `AI dispatch blocked by ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function backendModel(backend: Backend): string {
  switch (backend.kind) {
    case "pi":
      return `${backend.provider}/${backend.id}`;
    case "claude-cli":
      return backend.model;
    default: {
      const exhaustive: never = backend;
      return exhaustive;
    }
  }
}

export function backendLabel(backend: Backend): string {
  return `${backend.kind}/${backendModel(backend)}:${backend.thinking}`;
}

export function nativeTargets(policy: Policy): NativeTarget[] {
  const targets = new Map<string, NativeTarget>([[backendModel(policy.parent), policy.parent]]);
  for (const chain of policy.routes.values())
    for (const backend of chain)
      if (backend.kind === "pi") targets.set(backendModel(backend), backend);
  return [...targets.values()];
}

export function authorizeNative(
  policy: Policy,
  target: { provider: string; id: string },
): NativeTarget {
  const native = nativeTargets(policy).find(
    (allowed) => allowed.provider === target.provider && allowed.id === target.id,
  );
  if (!native)
    throw new Error(
      `AI policy blocks ${target.provider}/${target.id} in the ${policy.profile} profile. Select a declared native target.`,
    );
  return native;
}

export interface WorkerInvocation {
  profile: Policy["profile"];
  selection: ResolvedRoute["selection"];
  attempt: number;
}

export function parseWorkerInvocation(value: unknown): WorkerInvocation {
  if (
    !isRecord(value) ||
    (value.profile !== "work" && value.profile !== "personal") ||
    !isRecord(value.selection) ||
    typeof value.attempt !== "number" ||
    !Number.isInteger(value.attempt) ||
    value.attempt < 0 ||
    Object.keys(value).some((key) => !["profile", "selection", "attempt"].includes(key))
  )
    throw new Error("AI policy blocks invalid worker invocation.");
  const raw = value.selection;
  if (
    Object.keys(raw).some(
      (key) =>
        !(raw.kind === "role" ? ["kind", "role", "member"] : ["kind", "model"]).includes(key),
    )
  )
    throw new Error("AI policy blocks invalid worker selection.");
  let selection: WorkerInvocation["selection"];
  if (raw.kind === "role" && typeof raw.role === "string" && typeof raw.member === "string")
    selection = { kind: "role", role: raw.role, member: raw.member };
  else if (raw.kind === "raw" && typeof raw.model === "string")
    selection = { kind: "raw", model: raw.model };
  else throw new Error("AI policy blocks invalid worker selection.");
  return { profile: value.profile, selection, attempt: value.attempt };
}

export function resolveWorkerInvocation(
  policy: Policy,
  invocation: WorkerInvocation,
): NativeTarget {
  if (invocation.profile !== policy.profile)
    throw new Error("AI policy blocks changed worker profile. Restart the worker.");
  const selection = invocation.selection;
  let route: ResolvedRoute;
  switch (selection.kind) {
    case "role": {
      const role = policy.roles.get(selection.role);
      if (!role || (role.kind === "single" && role.route !== selection.member))
        throw new Error("AI policy blocks changed worker role.");
      route = resolveRoute(policy, {
        role: selection.role,
        ...(role.kind === "panel" ? { member: selection.member } : {}),
      });
      break;
    }
    case "raw":
      route = resolveRoute(policy, { model: selection.model });
      break;
    default: {
      const exhaustive: never = selection;
      return exhaustive;
    }
  }
  const target = route.chain[invocation.attempt];
  if (!target || target.kind !== "pi")
    throw new Error("AI policy worker invocation requires a native Pi target.");
  return target;
}

export function resolveRoute(policy: Policy, input: SelectionInput): ResolvedRoute {
  if (input.thinking !== undefined)
    throw new Error("Thinking overrides are forbidden; the selected policy owns effort.");
  if (input.role !== undefined && input.model !== undefined)
    throw new Error("Choose role or model, not both.");
  if (input.member !== undefined && input.seat !== undefined)
    throw new Error("Choose member or seat, not both.");
  if (input.model !== undefined) {
    if (input.member !== undefined || input.seat !== undefined)
      throw new Error("Raw models cannot select panel seats.");
    const matches = (backend: Backend) =>
      `${backend.kind === "pi" ? "" : "claude-cli/"}${backendModel(backend)}:${backend.thinking}` ===
      input.model;
    const chains = [...policy.routes.values()];
    const chain =
      chains.find(([head]) => matches(head)) ?? chains.find((route) => route.some(matches));
    if (!chain)
      throw new Error(`Model ${input.model} is not allowed by the ${policy.profile} profile.`);
    return { profile: policy.profile, selection: { kind: "raw", model: input.model }, chain };
  }
  const role = input.role === undefined ? undefined : policy.roles.get(input.role);
  if (!role || input.role === undefined)
    throw new Error(`Select a configured role. Available: ${[...policy.roles.keys()].join(", ")}`);
  let member: string;
  if (role.kind === "single") {
    if (input.member !== undefined || input.seat !== undefined)
      throw new Error(`Role ${input.role} is not a panel.`);
    member = role.route;
  } else {
    const selected =
      input.member ??
      (Number.isInteger(input.seat) && input.seat !== undefined
        ? role.members[input.seat]
        : undefined);
    if (!selected || !role.members.includes(selected))
      throw new Error(
        `Panel ${input.role} requires member or seat (zero-based): ${role.members.join(", ")}`,
      );
    member = selected;
  }
  const chain = policy.routes.get(member);
  if (!chain) return invalid(`missing route ${member}`);
  return { profile: policy.profile, selection: { kind: "role", role: input.role, member }, chain };
}

export function describePolicy(): string {
  try {
    const policy = loadPolicy();
    return [
      `Billing profile: ${policy.profile}. Reloaded at each dispatch.`,
      ...[...policy.roles].map(
        ([name, role]) =>
          `${name}: ${role.kind === "single" ? role.route : `panel members=${role.members.join(",")} (or zero-based seat)`}`,
      ),
      ...[...policy.routes].map(
        ([name, chain]) => `${name}: ${chain.map(backendLabel).join(" -> ")}`,
      ),
    ].join("\n");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
