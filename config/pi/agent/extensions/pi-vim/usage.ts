import type { Api, Model } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FETCH_TIMEOUT_MS = 5_000;
const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

export type UsageLayout = "bars" | "compact";
export type UsageAuthentication = {
  kind: "oauth" | "api-key";
  resolve: () => Promise<string | undefined>;
};
export type UsageModel = Pick<Model<Api>, "provider" | "cost">;
export type UsageSource = {
  label: string;
  layout: UsageLayout;
  fetch: (auth: UsageAuthentication) => Promise<unknown>;
  decode: (body: unknown) => UsageWindow[];
};

export type UsageWindow = {
  label: string;
  percent: number;
  resetAt: number | undefined;
};

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, key);
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function clampPercent(value: unknown): number {
  const parsed = number(value);
  if (parsed === undefined) return 0;
  return Math.max(0, Math.min(100, parsed));
}

function normalizePercent(value: unknown): number | undefined {
  const parsed = number(value);
  if (parsed === undefined) return undefined;
  return clampPercent(parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed);
}

function isoEpochSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : undefined;
}

function windowLabel(seconds: number): string {
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.max(1, Math.round(seconds / 3_600))}h`;
  return `${Math.max(1, Math.round(seconds / 86_400))}d`;
}

export function countdown(resetAt: number | undefined, now: number): string | undefined {
  if (resetAt === undefined || resetAt <= now) return undefined;
  const seconds = resetAt - now;
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

function authEntry(providerId: string): unknown {
  try {
    const entries: unknown = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
    return field(entries, providerId);
  } catch {
    return undefined;
  }
}

function claudeToken(): string | undefined {
  return nonEmptyString(field(authEntry("anthropic"), "access"));
}

async function requestBody(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchClaudeUsage(): Promise<unknown> {
  const token = claudeToken();
  if (token === undefined) return undefined;
  return requestBody("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.282",
    },
  });
}

function openaiWindow(entry: unknown): UsageWindow | undefined {
  const seconds = number(field(entry, "limit_window_seconds"));
  if (seconds === undefined || seconds <= 0) return undefined;
  return {
    label: windowLabel(seconds),
    percent: clampPercent(field(entry, "used_percent")),
    resetAt: number(field(entry, "reset_at")),
  };
}

async function fetchOpenAIUsage(auth: UsageAuthentication): Promise<unknown> {
  if (auth.kind !== "oauth") return undefined;
  const token = await auth.resolve();
  if (!token || token.startsWith("sk-")) return undefined;
  return requestBody("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "pi-agent",
    },
  });
}

async function fetchGoUsage(auth: UsageAuthentication): Promise<unknown> {
  const key = await auth.resolve();
  if (!key) return undefined;
  return requestBody("https://opencode.ai/zen/go/v1/usage", {
    headers: { Authorization: `Bearer ${key}` },
  });
}

export const USAGE_SOURCES: ReadonlyMap<string, UsageSource> = new Map<string, UsageSource>([
  [
    "anthropic",
    {
      label: "claude",
      layout: "bars",
      fetch: fetchClaudeUsage,
      decode(body) {
        const windows: UsageWindow[] = [];
        for (const { key, label } of [
          { key: "five_hour", label: "5h" },
          { key: "seven_day", label: "7d" },
        ]) {
          const entry = field(body, key);
          const percent = normalizePercent(field(entry, "utilization"));
          if (percent === undefined) continue;
          windows.push({ label, percent, resetAt: isoEpochSeconds(field(entry, "resets_at")) });
        }
        return windows;
      },
    },
  ],
  [
    "openai",
    {
      label: "gpt",
      layout: "bars",
      fetch: fetchOpenAIUsage,
      decode(body) {
        const rateLimit = field(body, "rate_limit");
        const windows: UsageWindow[] = [];
        for (const entry of [
          field(rateLimit, "primary_window"),
          field(rateLimit, "secondary_window"),
        ]) {
          const window = openaiWindow(entry);
          if (window !== undefined) windows.push(window);
        }
        return windows;
      },
    },
  ],
  [
    "opencode-go",
    {
      label: "go",
      layout: "compact",
      fetch: fetchGoUsage,
      decode(body) {
        const usage = field(body, "usage");
        const windows: UsageWindow[] = [];
        for (const { key, label } of [
          { key: "rolling", label: "5h" },
          { key: "weekly", label: "wk" },
          { key: "monthly", label: "mo" },
        ]) {
          const entry = field(usage, key);
          const status = field(entry, "status");
          const percent = number(field(entry, "percent"));
          const resetAt = isoEpochSeconds(field(entry, "resetsAt"));
          if (
            (status !== "ok" && status !== "rate-limited") ||
            percent === undefined ||
            !Number.isInteger(percent) ||
            percent < 0 ||
            percent > 100 ||
            resetAt === undefined
          ) {
            continue;
          }
          windows.push({ label, percent: clampPercent(percent), resetAt });
        }
        return windows;
      },
    },
  ],
]);

export async function fetchUsageWindows(
  providerId: string,
  auth: UsageAuthentication,
): Promise<UsageWindow[]> {
  const source = USAGE_SOURCES.get(providerId);
  if (source === undefined) return [];
  try {
    return source.decode(await source.fetch(auth));
  } catch {
    return [];
  }
}

export function usageProviderId(model: UsageModel | undefined): string | undefined {
  if (model === undefined || !USAGE_SOURCES.has(model.provider)) return undefined;
  const unlimited = [model.cost, ...(model.cost.tiers ?? [])].every(
    (cost) =>
      cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0,
  );
  return unlimited ? undefined : model.provider;
}
