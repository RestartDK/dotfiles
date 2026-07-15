# pi-index

A Tree-sitter-backed `index` tool for Pi. It reads a source file internally and returns a compact structural skeleton with exact line ranges, so the model can follow up with targeted `read(offset, limit)` calls instead of loading the entire file into context.

## Behavior

- Detects the language from the filename, extension, or shebang.
- Uses `@kreuzberg/tree-sitter-language-pack` for Tree-sitter parsing and structural extraction.
- Shows imports, modules, options, types, implementations, functions, constants, attributes, and Markdown heading sections when available.
- Supports explicit language overrides for extensionless or unusual files.
- Caches outlines in memory by path, modification time, size, and language override.
- Rejects directories, binary-looking files, and files larger than 2 MiB.
- Truncates pathological output to Pi's normal 2,000-line/50-KiB tool limits.

The first use of a language may download its compiled grammar into `~/.cache/tree-sitter-language-pack/`. Later calls reuse that grammar cache.

## Tool

```text
index({ path: "src/main.ts" })
index({ path: "script", language: "python" })
```

The tool prompt tells the model to use `index` before broad source reads, then use `read` with `offset` and `limit` for the relevant ranges. It does not block direct reads.

## Toggle it

Toggle the tool and its index-first prompt guidance for the current Pi session:

```text
/index-mode             # toggle
/index-mode off
/index-mode on
/index-mode status
```

When disabled, the `index` tool is removed from Pi's active tools, so its prompt guidance is removed too. The slash command remains available so it can be turned back on. To start an entire Pi process without it, use:

```bash
pi --exclude-tools index
```

## Development

Install runtime dependencies next to the extension:

```bash
cd ~/.pi/agent/extensions/pi-index
npm install --ignore-scripts
```

Run the parser/formatter tests:

```bash
npm test
```

Reload Pi after changes with `/reload`.
