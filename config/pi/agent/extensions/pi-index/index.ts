import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { Type } from "typebox";

import { indexSource, type IndexResult } from "./indexer.ts";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

interface CachedIndex {
  mtimeMs: number;
  size: number;
  languageOverride?: string;
  result: IndexResult;
}

interface IndexDetails {
  path: string;
  language: string;
  sourceLines: number;
  itemCount: number;
  parseErrors: number;
  cacheHit: boolean;
  truncated: boolean;
}

const cache = new Map<string, CachedIndex>();

function displayPath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  return rel && !rel.startsWith("..") ? rel : absolutePath;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "index",
    label: "Index",
    description: `Return a compact Tree-sitter skeleton of a source file: imports, modules, types, functions, methods, constants, headings, and exact line ranges. Reads files up to ${formatSize(MAX_SOURCE_BYTES)} internally but sends only the outline to the model. On first use of a language, its parser may be downloaded and cached. Use this before broad source-file reads, then call read with offset/limit for the relevant range.`,
    promptSnippet: "Inspect a source file's structural skeleton with exact line ranges",
    promptGuidelines: [
      "Use index before broad read calls on supported source files, then use read with offset/limit for only the relevant ranges.",
      "Use read directly for prose, unsupported formats, or when exact implementation text is already needed.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the source file, relative or absolute" }),
      language: Type.Optional(Type.String({ description: "Optional Tree-sitter language override, such as typescript, rust, nix, or python" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Index cancelled");

      const inputPath = params.path.replace(/^@/, "");
      const absolutePath = resolve(ctx.cwd, inputPath);
      const shownPath = displayPath(ctx.cwd, absolutePath);

      let metadata;
      try {
        metadata = await stat(absolutePath);
      } catch (error) {
        throw new Error(`Cannot index ${shownPath}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!metadata.isFile()) {
        throw new Error(metadata.isDirectory()
          ? `${shownPath} is a directory. Use index on a source file or ls/find on the directory.`
          : `${shownPath} is not a regular file.`);
      }
      if (metadata.size > MAX_SOURCE_BYTES) {
        throw new Error(`${shownPath} is ${formatSize(metadata.size)}, above the ${formatSize(MAX_SOURCE_BYTES)} index limit. Use read with offset/limit instead.`);
      }

      const languageOverride = params.language?.trim().toLowerCase() || undefined;
      const cached = cache.get(absolutePath);
      let result: IndexResult;
      let cacheHit = false;

      if (cached
        && cached.mtimeMs === metadata.mtimeMs
        && cached.size === metadata.size
        && cached.languageOverride === languageOverride) {
        result = cached.result;
        cacheHit = true;
      } else {
        onUpdate?.({
          content: [{ type: "text", text: `Parsing ${shownPath} with Tree-sitter…` }],
          details: { path: absolutePath },
        });

        const source = await readFile(absolutePath, "utf8");
        if (signal?.aborted) throw new Error("Index cancelled");
        if (source.includes("\0")) throw new Error(`${shownPath} appears to be binary. Use read instead.`);

        try {
          result = indexSource(shownPath, source, languageOverride);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Cannot index ${shownPath}: ${message}`);
        }

        cache.set(absolutePath, {
          mtimeMs: metadata.mtimeMs,
          size: metadata.size,
          languageOverride,
          result,
        });
      }

      const truncation = truncateHead(result.text, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });
      let output = truncation.content;
      if (truncation.truncated) {
        output += `\n\n[Outline truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Use targeted read calls for omitted ranges.]`;
      }

      const details: IndexDetails = {
        path: absolutePath,
        language: result.language,
        sourceLines: result.sourceLines,
        itemCount: result.itemCount,
        parseErrors: result.parseErrors,
        cacheHit,
        truncated: truncation.truncated,
      };

      return {
        content: [{ type: "text", text: output }],
        details,
      };
    },

    renderCall(args, theme) {
      const language = args.language ? theme.fg("dim", ` (${args.language})`) : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("index "))}${theme.fg("accent", args.path)}${language}`, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Parsing with Tree-sitter…"), 0, 0);
      const details = result.details as IndexDetails | undefined;
      if (!details) {
        const text = result.content.find((part) => part.type === "text")?.text ?? "Index failed";
        return new Text(theme.fg("error", text), 0, 0);
      }

      const flags = [
        details.cacheHit ? "cached" : undefined,
        details.parseErrors > 0 ? `${details.parseErrors} parse errors` : undefined,
        details.truncated ? "truncated" : undefined,
      ].filter(Boolean);
      let text = theme.fg("success", `${details.language} · ${details.sourceLines} lines · ${details.itemCount} items`);
      if (flags.length > 0) text += theme.fg("dim", ` (${flags.join(", ")})`);

      if (expanded) {
        const output = result.content.find((part) => part.type === "text")?.text;
        if (output) text += `\n${theme.fg("dim", output)}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("index-mode", {
    description: "Enable, disable, toggle, or show the Tree-sitter index tool for this Pi session",
    getArgumentCompletions: (prefix: string) => {
      const values = ["on", "off", "toggle", "status"];
      return values
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "toggle";
      const activeTools = pi.getActiveTools();
      const isActive = activeTools.includes("index");

      if (action === "status") {
        ctx.ui.notify(`Index mode is ${isActive ? "on" : "off"}.`, "info");
        return;
      }
      if (!["on", "off", "toggle"].includes(action)) {
        ctx.ui.notify("Usage: /index-mode [on|off|toggle|status]", "warning");
        return;
      }

      const enable = action === "on" || (action === "toggle" && !isActive);
      const nextTools = enable
        ? [...new Set([...activeTools, "index"])]
        : activeTools.filter((name) => name !== "index");
      pi.setActiveTools(nextTools);

      ctx.ui.notify(
        enable
          ? "Index mode is on. Pi will prefer index before broad source reads."
          : "Index mode is off. The index tool and its index-first prompt guidance are disabled for this session.",
        "info",
      );
    },
  });
}
