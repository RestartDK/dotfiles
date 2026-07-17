import { createRequire } from "node:module";
import { basename, extname } from "node:path";

import type {
  ExportInfo,
  ImportInfo,
  Node as TreeSitterNode,
  ProcessResult,
  Span,
  StructureItem,
  SymbolInfo,
} from "@kreuzberg/tree-sitter-language-pack";

const require = createRequire(import.meta.url);
const treeSitter = require("@kreuzberg/tree-sitter-language-pack") as typeof import("@kreuzberg/tree-sitter-language-pack");

const MAX_IMPORTS = 80;
const MAX_TOP_LEVEL_ITEMS = 250;
const MAX_CHILDREN = 40;
const MAX_SYMBOLS = 120;
const MAX_TEXT_LENGTH = 220;

const FILE_NAME_LANGUAGES: Record<string, string> = {
  BUILD: "starlark",
  "BUILD.bazel": "starlark",
  "MODULE.bazel": "starlark",
  Dockerfile: "dockerfile",
  Makefile: "make",
  Rakefile: "ruby",
};

const LANGUAGE_ALIASES: Record<string, string> = {
  "c#": "csharp",
  c_sharp: "csharp",
  cs: "csharp",
  cxx: "cpp",
  ex: "elixir",
  exs: "elixir",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
};

const KIND_LABELS: Record<string, string> = {
  Attribute: "attr",
  Class: "class",
  Constant: "const",
  Enum: "enum",
  Function: "",
  Impl: "impl",
  Interface: "interface",
  Method: "",
  Module: "module",
  Namespace: "namespace",
  Option: "option",
  Other: "item",
  Struct: "struct",
  Trait: "trait",
  Type: "type",
  Variable: "var",
};

const SECTION_ORDER = ["imports", "modules", "options", "types", "impls", "functions", "constants", "attributes", "headings", "items"] as const;
type SectionName = (typeof SECTION_ORDER)[number];

interface OutlineItem {
  kind: string;
  text: string;
  span?: Span;
  children?: OutlineItem[];
}

export interface IndexResult {
  text: string;
  language: string;
  sourceLines: number;
  itemCount: number;
  parseErrors: number;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, max = MAX_TEXT_LENGTH): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 12)).trimEnd()}…[truncated]`;
}

function spanStart(span?: Span): number | undefined {
  return typeof span?.startByte === "number" ? span.startByte : undefined;
}

function spanEnd(span?: Span): number | undefined {
  return typeof span?.endByte === "number" ? span.endByte : undefined;
}

function sourceSlice(sourceBytes: Buffer, start?: number, end?: number): string {
  if (typeof start !== "number" || typeof end !== "number") return "";
  const safeStart = Math.max(0, Math.min(start, sourceBytes.length));
  const safeEnd = Math.max(safeStart, Math.min(end, sourceBytes.length));
  return sourceBytes.subarray(safeStart, safeEnd).toString("utf8");
}

function nodeSpan(node: TreeSitterNode): Span {
  const start = node.startPosition();
  const end = node.endPosition();
  return {
    startByte: node.startByte(),
    endByte: node.endByte(),
    startLine: start.row,
    startColumn: start.column,
    endLine: end.row,
    endColumn: end.column,
  };
}

function nodeText(node: TreeSitterNode, sourceBytes: Buffer): string {
  return sourceSlice(sourceBytes, node.startByte(), node.endByte());
}

function rangeText(span?: Span): string {
  if (typeof span?.startLine !== "number") return "";

  const start = span.startLine + 1;
  let end = typeof span.endLine === "number" ? span.endLine + 1 : start;
  if (end > start && span.endColumn === 0) end -= 1;

  return start === end ? `[${start}]` : `[${start}-${end}]`;
}

function sectionForKind(kind: string): SectionName {
  switch (kind) {
    case "Module":
    case "Namespace":
      return "modules";
    case "Option":
      return "options";
    case "Class":
    case "Enum":
    case "Interface":
    case "Struct":
    case "Trait":
    case "Type":
      return "types";
    case "Impl":
      return "impls";
    case "Function":
    case "Method":
      return "functions";
    case "Constant":
    case "Variable":
      return "constants";
    case "Attribute":
      return "attributes";
    case "Heading":
      return "headings";
    case "Import":
      return "imports";
    default:
      return "items";
  }
}

function kindName(kind: unknown): string {
  if (typeof kind === "string") return kind;
  if (kind && typeof kind === "object") {
    const value = Object.values(kind as Record<string, unknown>)[0];
    if (typeof value === "string") return value;
  }
  return "Other";
}

function itemSignature(item: StructureItem, sourceBytes: Buffer): string {
  if (item.signature) return truncateText(item.signature);

  const start = spanStart(item.span);
  const bodyStart = spanStart(item.bodySpan);
  const end = spanEnd(item.span);
  const signatureEnd = typeof bodyStart === "number" && bodyStart > (start ?? -1) ? bodyStart : end;
  const fromSource = truncateText(sourceSlice(sourceBytes, start, signatureEnd));
  if (fromSource) return fromSource.replace(/[{:;,]\s*$/, "").trimEnd();
  return item.name ?? "anonymous";
}

function structureToOutline(item: StructureItem, sourceBytes: Buffer): OutlineItem {
  const kind = kindName(item.kind);
  let text = itemSignature(item, sourceBytes);
  const label = KIND_LABELS[kind];

  if (label && item.name && !new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) {
    text = `${label} ${text || item.name}`;
  }

  const includeChildren = ["Class", "Impl", "Interface", "Module", "Struct", "Trait"].includes(kind);
  const sourceChildren = includeChildren ? topLevelStructures(item.children ?? []) : [];
  const children = sourceChildren.slice(0, MAX_CHILDREN).map((child) => structureToOutline(child, sourceBytes));
  if (sourceChildren.length > MAX_CHILDREN) {
    children.push({
      kind: "Other",
      text: `[${sourceChildren.length - MAX_CHILDREN} more members truncated]`,
    });
  }

  return {
    kind,
    text: truncateText(text),
    span: item.span,
    children,
  };
}

function containsSpan(outer?: Span, inner?: Span): boolean {
  const outerStart = spanStart(outer);
  const outerEnd = spanEnd(outer);
  const innerStart = spanStart(inner);
  const innerEnd = spanEnd(inner);
  return typeof outerStart === "number"
    && typeof outerEnd === "number"
    && typeof innerStart === "number"
    && typeof innerEnd === "number"
    && outerStart <= innerStart
    && outerEnd >= innerEnd;
}

function flattenStructure(items: StructureItem[]): StructureItem[] {
  const flattened: StructureItem[] = [];
  const visit = (item: StructureItem) => {
    flattened.push(item);
    for (const child of item.children ?? []) visit(child);
  };
  for (const item of items) visit(item);
  return flattened;
}

function topLevelStructures(items: StructureItem[]): StructureItem[] {
  const deduplicated = items.filter((item, index) => {
    const start = spanStart(item.span);
    const end = spanEnd(item.span);
    if (typeof start === "number" && typeof end === "number") {
      return items.findIndex((candidate) => spanStart(candidate.span) === start && spanEnd(candidate.span) === end) === index;
    }
    const key = `${kindName(item.kind)}:${item.name ?? ""}`;
    return items.findIndex((candidate) => `${kindName(candidate.kind)}:${candidate.name ?? ""}` === key) === index;
  });

  return deduplicated.filter((item, index) => !deduplicated.some((outer, outerIndex) => {
    if (index === outerIndex || !containsSpan(outer.span, item.span)) return false;
    const outerStart = spanStart(outer.span);
    const outerEnd = spanEnd(outer.span);
    const itemStart = spanStart(item.span);
    const itemEnd = spanEnd(item.span);
    return outerStart !== itemStart || outerEnd !== itemEnd;
  }));
}

function uniqueImports(imports: ImportInfo[], sourceBytes: Buffer): OutlineItem[] {
  const sorted = [...imports].sort((a, b) => {
    const startDiff = (spanStart(a.span) ?? 0) - (spanStart(b.span) ?? 0);
    if (startDiff !== 0) return startDiff;
    return (spanEnd(b.span) ?? 0) - (spanEnd(a.span) ?? 0);
  });

  const selected: ImportInfo[] = [];
  const seen = new Set<string>();
  for (const item of sorted) {
    if (selected.some((outer) => containsSpan(outer.span, item.span))) continue;
    const raw = item.source || sourceSlice(sourceBytes, spanStart(item.span), spanEnd(item.span));
    const text = truncateText(raw, 240).replace(/;$/, "");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    selected.push(item);
    if (selected.length >= MAX_IMPORTS) break;
  }

  const outline: OutlineItem[] = selected.map((item) => ({
    kind: "Import",
    text: truncateText(item.source || sourceSlice(sourceBytes, spanStart(item.span), spanEnd(item.span)), 240).replace(/;$/, ""),
    span: item.span,
  }));

  if (imports.length > selected.length) {
    outline.push({ kind: "Other", text: `[${imports.length - selected.length} more imports omitted]` });
  }
  return outline;
}

function leftoverSymbols(symbols: SymbolInfo[], structures: StructureItem[], sourceBytes: Buffer): OutlineItem[] {
  const flattened = flattenStructure(structures);
  const seen = new Set<string>();
  const result: OutlineItem[] = [];

  for (const symbol of symbols) {
    const kind = kindName(symbol.kind);
    if (!symbol.name || ["Class", "Enum", "Function", "Interface", "Module"].includes(kind)) continue;
    if (flattened.some((item) => item.name === symbol.name && containsSpan(item.span, symbol.span))) continue;

    const key = `${kind}:${symbol.name}:${symbol.span?.startByte ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const raw = sourceSlice(sourceBytes, spanStart(symbol.span), spanEnd(symbol.span));
    const label = KIND_LABELS[kind] ?? kind.toLowerCase();
    let text = truncateText(raw || symbol.name);
    if (!new RegExp(`\\b${label}\\b`, "i").test(text)) text = `${label} ${text}`;
    if (symbol.typeAnnotation && !text.includes(symbol.typeAnnotation)) text += `: ${symbol.typeAnnotation}`;

    result.push({ kind, text: truncateText(text), span: symbol.span });
    if (result.length >= MAX_SYMBOLS) break;
  }

  if (symbols.length > result.length && result.length >= MAX_SYMBOLS) {
    result.push({ kind: "Other", text: `[additional symbols truncated]` });
  }
  return result;
}

function uncoveredExports(exports: ExportInfo[], structures: StructureItem[], symbols: SymbolInfo[], sourceBytes: Buffer): OutlineItem[] {
  const represented = [...flattenStructure(structures).map((item) => item.span), ...symbols.map((symbol) => symbol.span)];
  const result: OutlineItem[] = [];

  for (const item of exports) {
    if (represented.some((span) => containsSpan(item.span, span))) continue;
    const raw = sourceSlice(sourceBytes, spanStart(item.span), spanEnd(item.span)) || item.name || "";
    if (!/\b(const|let|static|type|val|var)\b/.test(raw)) continue;
    const kind = /\btype\b/.test(raw) ? "Type" : "Constant";
    result.push({ kind, text: truncateText(raw), span: item.span });
  }
  return result;
}

function walkNamed(node: TreeSitterNode, visit: (node: TreeSitterNode) => void): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount(); i++) {
    const child = node.namedChild(i);
    if (child) walkNamed(child, visit);
  }
}

function firstNamedChild(node: TreeSitterNode): TreeSitterNode | null {
  return node.namedChildCount() > 0 ? node.namedChild(0) : null;
}

function markdownOutline(root: TreeSitterNode, sourceBytes: Buffer, totalLines: number): OutlineItem[] {
  const headings: Array<{ level: number; item: OutlineItem }> = [];
  walkNamed(root, (node) => {
    if (node.kind() !== "atx_heading" && node.kind() !== "setext_heading") return;
    const raw = nodeText(node, sourceBytes).split(/\r?\n/, 1)[0]?.trim() ?? "";
    let level = raw.match(/^(#+)/)?.[1]?.length ?? 0;
    if (level === 0) level = /=+\s*$/.test(nodeText(node, sourceBytes)) ? 1 : 2;
    const title = raw.replace(/^#+\s*/, "").replace(/\s*#+\s*$/, "").trim();
    headings.push({
      level,
      item: {
        kind: "Heading",
        text: `${"#".repeat(level)} ${title}`,
        span: nodeSpan(node),
      },
    });
  });

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i]!;
    const startLine = current.item.span?.startLine ?? 0;
    let endLine = Math.max(startLine, totalLines - 1);
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j]!.level <= current.level) {
        endLine = Math.max(startLine, (headings[j]!.item.span?.startLine ?? startLine + 1) - 1);
        break;
      }
    }
    current.item.span = {
      ...current.item.span,
      endLine,
      endColumn: 1,
    };
  }

  return headings.map((heading) => heading.item);
}

function hasBindingAncestor(node: TreeSitterNode): boolean {
  let parent = node.parent();
  while (parent) {
    if (parent.kind() === "binding") return true;
    parent = parent.parent();
  }
  return false;
}

function nixOutline(root: TreeSitterNode, sourceBytes: Buffer): OutlineItem[] {
  const result: OutlineItem[] = [];
  const expression = root.childByFieldName("expression") ?? firstNamedChild(root);
  if (expression?.kind() === "function_expression") {
    const formals = expression.childByFieldName("formals") ?? firstNamedChild(expression);
    if (formals) {
      result.push({
        kind: "Module",
        text: `module ${truncateText(nodeText(formals, sourceBytes), 160)}`,
        span: nodeSpan(expression),
      });
    }
  }

  walkNamed(root, (node) => {
    if (node.kind() !== "binding" || hasBindingAncestor(node)) return;
    const attrpath = node.childByFieldName("attrpath") ?? firstNamedChild(node);
    const value = node.childByFieldName("expression");
    if (!attrpath) return;

    const name = truncateText(nodeText(attrpath, sourceBytes), 140);
    if (!name) return;

    let kind = name.startsWith("options.") ? "Option" : "Attribute";
    let text = name;
    if (value?.kind() === "function_expression") {
      kind = "Function";
      const body = value.childByFieldName("body");
      const prefix = sourceSlice(sourceBytes, value.startByte(), body?.startByte() ?? value.endByte()).replace(/\s+$/, "");
      text = `${name} = ${truncateText(prefix, 150)}`;
    } else if (value) {
      const rawValue = nodeText(value, sourceBytes);
      const valueText = truncateText(rawValue, 100);
      if (valueText.length <= 100 && !/[\n\r{}]/.test(rawValue)) text = `${name} = ${valueText}`;
    }

    result.push({ kind, text, span: nodeSpan(node) });
  });
  return result;
}

function elixirOutline(root: TreeSitterNode, sourceBytes: Buffer): OutlineItem[] {
  const result: OutlineItem[] = [];
  const targets = new Set(["def", "defdelegate", "defguard", "defmacro", "defmacrop", "defmodule", "defp", "defprotocol", "defimpl"]);

  walkNamed(root, (node) => {
    if (node.kind() !== "call") return;
    const target = node.childByFieldName("target");
    const targetText = target ? nodeText(target, sourceBytes) : "";
    if (!targets.has(targetText)) return;

    const raw = normalizeWhitespace(nodeText(node, sourceBytes));
    const nameMatch = targetText === "defmodule" || targetText === "defprotocol" || targetText === "defimpl"
      ? raw.match(/^\w+\s+([^\s,]+)(?:\s+do|,\s*do:)/)
      : raw.match(/^\w+\s+([A-Za-z_][A-Za-z0-9_!?]*)/);
    if (!nameMatch?.[1]) return;

    const signature = raw
      .replace(/,\s*do:.*$/, "")
      .replace(/\s+do\s.*$/, "")
      .replace(/\s+do$/, "");
    result.push({
      kind: targetText.includes("module") || targetText.includes("protocol") || targetText.includes("impl") ? "Module" : "Function",
      text: truncateText(signature),
      span: nodeSpan(node),
    });
  });
  return result;
}

function zigOutline(root: TreeSitterNode, sourceBytes: Buffer): OutlineItem[] {
  const result: OutlineItem[] = [];
  walkNamed(root, (node) => {
    if (node.kind() === "FnProto") {
      const declaration = node.parent()?.kind() === "Decl" ? node.parent()! : node;
      const name = node.childByFieldName("function");
      const body = Array.from({ length: declaration.namedChildCount() }, (_, index) => declaration.namedChild(index))
        .find((child) => child?.kind() === "Block");
      const raw = sourceSlice(sourceBytes, declaration.startByte(), body?.startByte() ?? node.endByte());
      result.push({
        kind: "Function",
        text: truncateText(raw || (name ? nodeText(name, sourceBytes) : "anonymous")),
        span: nodeSpan(declaration),
      });
      return;
    }

    if (node.kind() !== "VarDecl") return;
    const name = node.childByFieldName("variable_type_function");
    if (!name) return;
    const raw = truncateText(nodeText(node.parent()?.kind() === "Decl" ? node.parent()! : node, sourceBytes));
    const kind = /\b(enum|struct|union|opaque)\b/.test(raw) ? (/\benum\b/.test(raw) ? "Enum" : "Struct") : "Constant";
    result.push({ kind, text: raw, span: nodeSpan(node.parent()?.kind() === "Decl" ? node.parent()! : node) });
  });
  return result;
}

const GENERIC_NODE_KINDS: Record<string, string> = {
  class_declaration: "Class",
  class_definition: "Class",
  enum_declaration: "Enum",
  enum_item: "Enum",
  enum_specifier: "Enum",
  function_declaration: "Function",
  function_definition: "Function",
  function_item: "Function",
  interface_declaration: "Interface",
  interface_type: "Interface",
  method_declaration: "Method",
  method_definition: "Method",
  module_declaration: "Module",
  namespace_definition: "Namespace",
  struct_item: "Struct",
  struct_specifier: "Struct",
  trait_item: "Trait",
  impl_item: "Impl",
};

function genericOutline(root: TreeSitterNode, sourceBytes: Buffer): OutlineItem[] {
  const result: OutlineItem[] = [];
  walkNamed(root, (node) => {
    const kind = GENERIC_NODE_KINDS[node.kind()];
    if (!kind) return;
    const name = node.childByFieldName("name")
      ?? node.childByFieldName("function")
      ?? node.childByFieldName("declarator")
      ?? node.childByFieldName("target");
    const body = node.childByFieldName("body");
    const raw = sourceSlice(sourceBytes, node.startByte(), body?.startByte() ?? node.endByte());
    const fallbackName = name ? nodeText(name, sourceBytes) : node.kind();
    result.push({ kind, text: truncateText(raw || fallbackName), span: nodeSpan(node) });
  });
  return result;
}

function specializedOutline(language: string, source: string, totalLines: number, needsFallback: boolean): OutlineItem[] {
  const hasSpecializedExtractor = ["elixir", "markdown", "nix", "zig"].includes(language);
  if (!hasSpecializedExtractor && !needsFallback) return [];

  const parser = treeSitter.getParser(language);
  const tree = parser.parse(source);
  if (!tree) return [];
  const root = tree.rootNode();
  const sourceBytes = Buffer.from(source, "utf8");

  switch (language) {
    case "markdown":
      return markdownOutline(root, sourceBytes, totalLines);
    case "nix":
      return nixOutline(root, sourceBytes);
    case "elixir":
      return elixirOutline(root, sourceBytes);
    case "zig":
      return zigOutline(root, sourceBytes);
    default:
      return genericOutline(root, sourceBytes);
  }
}

function sectionRange(items: OutlineItem[]): string {
  const spans = items.map((item) => item.span).filter((span): span is Span => typeof span?.startLine === "number");
  if (spans.length === 0) return "";
  const start = Math.min(...spans.map((span) => span.startLine ?? 0));
  const end = Math.max(...spans.map((span) => span.endLine ?? span.startLine ?? 0));
  return rangeText({ startLine: start, endLine: end, endColumn: 1 });
}

function formatOutline(path: string, language: string, totalLines: number, parseErrors: number, items: OutlineItem[]): { text: string; itemCount: number } {
  const sections = new Map<SectionName, OutlineItem[]>();
  for (const item of items) {
    const section = sectionForKind(item.kind);
    const list = sections.get(section) ?? [];
    list.push(item);
    sections.set(section, list);
  }

  const lines = [`${path} (${totalLines} lines, ${language})`];
  let itemCount = 0;
  if (parseErrors > 0) lines.push(`[tree-sitter recovered from ${parseErrors} parse error${parseErrors === 1 ? "" : "s"}; outline may be incomplete]`);

  for (const section of SECTION_ORDER) {
    const sectionItems = sections.get(section);
    if (!sectionItems?.length) continue;
    lines.push("");
    const aggregate = sectionRange(sectionItems);
    lines.push(`${section}:${aggregate ? ` ${aggregate}` : ""}`);

    const limited = sectionItems.slice(0, MAX_TOP_LEVEL_ITEMS);
    for (const item of limited) {
      const range = rangeText(item.span);
      lines.push(`  ${item.text}${range ? ` ${range}` : ""}`);
      itemCount += 1;
      for (const child of item.children ?? []) {
        const childRange = rangeText(child.span);
        lines.push(`    ${child.text}${childRange ? ` ${childRange}` : ""}`);
        itemCount += 1;
      }
    }
    if (sectionItems.length > limited.length) lines.push(`  [${sectionItems.length - limited.length} more items truncated]`);
  }

  if (itemCount === 0) {
    lines.push("", "No structural declarations found. Use read for the file contents.");
  } else {
    lines.push("", "Use read with offset/limit for the specific ranges you need.");
  }

  return { text: lines.join("\n"), itemCount };
}

export function detectLanguage(path: string, source: string, override?: string): string | null {
  if (override?.trim()) {
    const normalized = override.trim().toLowerCase();
    return LANGUAGE_ALIASES[normalized] ?? normalized;
  }

  const special = FILE_NAME_LANGUAGES[basename(path)];
  if (special) return special;

  const detected = treeSitter.detectLanguageFromPath(path)
    ?? treeSitter.detectLanguageFromExtension(extname(path).replace(/^\./, ""))
    ?? treeSitter.detectLanguageFromContent(source);
  return detected ? (LANGUAGE_ALIASES[detected.toLowerCase()] ?? detected.toLowerCase()) : null;
}

export function indexSource(path: string, source: string, languageOverride?: string): IndexResult {
  const language = detectLanguage(path, source, languageOverride);
  if (!language) throw new Error(`Unsupported file type for ${path}. Use read instead, or pass a Tree-sitter language name.`);
  if (!treeSitter.hasLanguage(language)) throw new Error(`Tree-sitter language '${language}' is not available. Use read instead.`);

  const analysis = treeSitter.process(source, {
    language,
    structure: true,
    imports: true,
    exports: true,
    comments: false,
    docstrings: false,
    symbols: true,
    diagnostics: true,
  }) as ProcessResult;

  const sourceBytes = Buffer.from(source, "utf8");
  const structures = analysis.structure ?? [];
  const visibleStructures = topLevelStructures(structures);
  const symbols = analysis.symbols ?? [];
  const totalLines = analysis.metrics?.totalLines ?? Math.max(1, source.split(/\r\n|\r|\n/).length);
  const parseErrors = analysis.metrics?.errorCount ?? analysis.diagnostics?.length ?? 0;

  const items: OutlineItem[] = [
    ...uniqueImports(analysis.imports ?? [], sourceBytes),
    ...visibleStructures.slice(0, MAX_TOP_LEVEL_ITEMS).map((item) => structureToOutline(item, sourceBytes)),
    ...leftoverSymbols(symbols, structures, sourceBytes),
    ...uncoveredExports(analysis.exports ?? [], structures, symbols, sourceBytes),
  ];

  const needsFallback = structures.length === 0 && symbols.length === 0;
  const special = specializedOutline(language, source, totalLines, needsFallback);
  const existingKeys = new Set(items.map((item) => `${item.kind}:${item.span?.startByte ?? ""}:${item.text}`));
  for (const item of special) {
    const key = `${item.kind}:${item.span?.startByte ?? ""}:${item.text}`;
    if (!existingKeys.has(key)) items.push(item);
  }

  const formatted = formatOutline(path, language, totalLines, parseErrors, items);
  return {
    text: formatted.text,
    language,
    sourceLines: totalLines,
    itemCount: formatted.itemCount,
    parseErrors,
  };
}
