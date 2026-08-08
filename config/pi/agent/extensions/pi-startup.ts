import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const art = String.raw`          :#@@+  +@@#:
          *@@@+  +@@@*
         *@@@@+  +@@@@*
       =#@@@@@+  +@@@@@#=
    .=#@@@@@@@+  +@@@@@@@#=.
++#%@@@@@@@@@@+  +@@@@@@@@@@%#++
@@@@@@@@@@@@@@+  +@@@@@@@@@@@@@@


@@@@@@@@@@@@@@+  +@@@@@@@@@@@@@@
++#%@@@@@@@@@@+  +@@@@@@@@@@%#++
    .=#@@@@@@@+  +@@@@@@@#=.
       =#@@@@@+  +@@@@@#=
         *@@@@+  +@@@@*
          *@@@+  +@@@*
          :#@@+  +@@#:`;

function countFiles(paths: string[]): number {
  return paths.filter((path) => existsSync(path)).length;
}

function centerLine(line: string, width: number): string {
  const lineWidth = visibleWidth(line);
  if (lineWidth > width) return truncateToWidth(line, width, "…");
  return " ".repeat(Math.max(0, Math.floor((width - lineWidth) / 2))) + line;
}

function topPadding(contentHeight: number): string[] {
  const rows = process.stdout.rows ?? 0;
  // Leave room for the editor/footer so the startup block sits near screen center.
  const reservedBottomRows = 6;
  const padding = Math.max(0, Math.floor((rows - reservedBottomRows - contentHeight) / 2));
  return Array.from({ length: padding }, () => "");
}

interface StartupConfig {
  enabled: boolean;
  greeting: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeSettings(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    merged[key] =
      isRecord(baseValue) && isRecord(overrideValue)
        ? mergeSettings(baseValue, overrideValue)
        : overrideValue;
  }

  return merged;
}

function readSettingsFile(settingsPath: string): Record<string, unknown> {
  try {
    if (!existsSync(settingsPath)) return {};
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readSettings(cwd: string): Record<string, unknown> {
  const home = homedir();
  return mergeSettings(
    readSettingsFile(join(home, ".pi", "agent", "settings.json")),
    readSettingsFile(join(cwd, ".pi", "settings.json")),
  );
}

function readStartupConfig(cwd: string): StartupConfig {
  const raw = readSettings(cwd).piStartup;
  const fallbackGreeting = "hey dk :)";

  if (raw === true) {
    return { enabled: true, greeting: fallbackGreeting };
  }

  if (!isRecord(raw)) {
    return { enabled: false, greeting: fallbackGreeting };
  }

  const greeting =
    typeof raw.greeting === "string" && raw.greeting.trim().length > 0
      ? raw.greeting.trim()
      : fallbackGreeting;

  return {
    enabled: raw.enabled === true,
    greeting,
  };
}

function countExtensionEntries(cwd: string): number {
  const home = homedir();
  const counted = new Set<string>();

  for (const settingsPath of [
    join(home, ".pi", "agent", "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ]) {
    try {
      if (!existsSync(settingsPath)) continue;
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const packages = Array.isArray(settings?.packages) ? settings.packages : [];
      for (const pkg of packages) {
        const source = typeof pkg === "string" ? pkg : pkg?.source;
        const extensions = typeof pkg === "object" && pkg !== null ? pkg.extensions : undefined;
        if (Array.isArray(extensions) && extensions.length === 0) continue;
        if (typeof source === "string" && source.startsWith("npm:")) {
          const body = source.slice(4);
          const versionIndex = body.lastIndexOf("@");
          counted.add(versionIndex > 0 ? body.slice(0, versionIndex) : body);
        }
      }
    } catch {
      // Ignore malformed settings for a decorative startup header.
    }
  }

  for (const dir of [join(home, ".pi", "agent", "extensions"), join(cwd, ".pi", "extensions")]) {
    try {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const entryPath = join(dir, entry);
        const stats = statSync(entryPath);
        if (stats.isDirectory()) {
          if (existsSync(join(entryPath, "index.ts")) || existsSync(join(entryPath, "index.js")))
            counted.add(entry);
        } else if ((entry.endsWith(".ts") || entry.endsWith(".js")) && !entry.startsWith(".")) {
          counted.add(basename(entry, entry.endsWith(".ts") ? ".ts" : ".js"));
        }
      }
    } catch {
      // Ignore unreadable extension directories.
    }
  }

  return counted.size;
}

function countSkillDirs(cwd: string): number {
  const home = homedir();
  const counted = new Set<string>();
  for (const dir of [
    join(home, ".pi", "agent", "skills"),
    join(cwd, ".pi", "skills"),
    join(cwd, "skills"),
  ]) {
    try {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        if (existsSync(join(dir, entry, "SKILL.md"))) counted.add(entry);
      }
    } catch {
      // Ignore unreadable skill directories.
    }
  }
  return counted.size;
}

function countPromptTemplates(cwd: string): number {
  const home = homedir();
  const counted = new Set<string>();

  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const entryPath = join(dir, entry);
      const stats = statSync(entryPath);
      if (stats.isDirectory()) walk(entryPath);
      else if (entry.endsWith(".md")) counted.add(basename(entry, ".md"));
    }
  }

  for (const dir of [
    join(home, ".pi", "agent", "commands"),
    join(home, ".claude", "commands"),
    join(cwd, ".pi", "commands"),
    join(cwd, ".claude", "commands"),
  ]) {
    try {
      walk(dir);
    } catch {
      // Ignore unreadable prompt template directories.
    }
  }

  return counted.size;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" || !ctx.hasUI) return;

    const startupConfig = readStartupConfig(ctx.cwd);
    if (!startupConfig.enabled) return;

    const home = homedir();
    const lines = art.trimEnd().split("\n");
    const artWidth = Math.max(...lines.map((line) => visibleWidth(line)));
    const contextFiles = countFiles([
      join(home, ".pi", "agent", "AGENTS.md"),
      join(home, ".claude", "AGENTS.md"),
      join(ctx.cwd, "AGENTS.md"),
      join(ctx.cwd, ".pi", "AGENTS.md"),
      join(ctx.cwd, ".claude", "AGENTS.md"),
    ]);
    const statsLine = `${startupConfig.greeting} · ${contextFiles} prompts · ${countExtensionEntries(ctx.cwd)} extensions · ${countSkillDirs(ctx.cwd)} skills · ${countPromptTemplates(ctx.cwd)} prompts`;

    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number) {
        const renderedLines = [
          ...lines.map((line) => centerLine(theme.fg("accent", line.padEnd(artWidth)), width)),
          "",
          centerLine(theme.fg("muted", statsLine), width),
        ];

        return [...topPadding(renderedLines.length), ...renderedLines];
      },
      invalidate() {},
    }));
  });
}
