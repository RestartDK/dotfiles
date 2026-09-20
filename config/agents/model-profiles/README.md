# Subagent model profiles

Nix selects `work.json` or `personal.json` with `my.liveConfig.agentProfile`. The standard Mac uses personal. Twin Mac, Twin Home Manager and the Cobb bridge use work. The selected file is live-linked at `$XDG_CONFIG_HOME/dstack/models.json`, or `~/.config/dstack/models.json` when XDG_CONFIG_HOME is unset. Interactive parent-model defaults do not change.

`/subagents` shows the active profile, roles, panel members and backend chains. The dispatcher reloads this global file for each call. Project settings cannot replace it. Missing, malformed or incomplete policy stops dispatch.

```json
{"agent":"dstack-agent","role":"feature","task":"Implement the scoped change"}
{"agent":"dstack-agent","role":"arena-runners","member":"fable","task":"Review the design"}
{"agent":"comment-sicko","role":"review","task":"Review the current diff"}
```

Panels require `member` or a zero-based `seat`, never both. Managed dstack agents require roles. Ad-hoc `model` requests must match a declared route including effort and cannot bypass subscription priority. `thinking` overrides and combined `role`/`model` inputs are rejected. Personal policy cannot dispatch Anthropic API models.

## Subscription backend

Fable first uses Claude Code with claude.ai authentication. Work can fall back to Pi Anthropic, then Pi OpenAI Astra. Personal falls back only to Pi Codex Astra. Results report the actual backend/model, configured role and every attempt. Fallback can make panel members share a model family. Pi checks the selected provider's authentication before a model request and passes separate provider and model flags, so model-pattern matching cannot substitute another provider.

Claude runs with safe mode, empty setting sources, hooks disabled, strict empty MCP configuration, no skills or Chrome, no persisted session, and `dontAsk` permissions. The child receives a small environment allowlist without API keys, auth-token overrides, provider switches or config-directory overrides. An auth-status check must confirm claude.ai and firstParty before dispatch. Init must confirm the requested model, exact tool set, no MCP and no API-key source.

Only requested tools are mapped and autoallowed. `read`, `grep`, `find`, `edit`, `write` and `bash` map to Claude's built-ins. `ls` maps to Glob for entry discovery, not Bash. Glob does not reproduce all ls metadata, hidden-file or directory-listing behavior. Unsupported capabilities, including Pi extension and MCP tools, block the call rather than silently disappear. Explicit `tools: []` stays empty. Global and ancestor project instructions use AGENTS.override.md, AGENTS.md, then CLAUDE.md precedence per directory. They join preset instructions and the explicit system prompt in a private temporary file, which is removed after the attempt. Pi-specific tools named in those instructions remain unavailable in Claude.

Fallback requires a terminal, recognized provider failure before any tool use. Any tool-use event, including a read, closes fallback. Task/test failures, unknown errors, malformed or truncated streams, scope mismatches and cancellation never advance. The parent must reconcile partial work before retrying. The tool latch does not protect against arbitrary external startup side effects; startup customizations are disabled separately.

Each endpoint is attempted at most once per chain. A process-local cache skips recently unavailable endpoints, including the final endpoint. Known reset times are normalized from seconds and capped at 24 hours; otherwise cooldown is 60 seconds. There is no daemon, lockfile or retry loop. Output is bounded to 50 KiB, stderr to 16 KiB, JSON lines to 1 MiB and each stream to 16 MiB.

## Checks

- `bun test tests/agent-profiles` runs policy tests and real fixture executables without provider credentials.
- `nix build --no-link .#checks.aarch64-darwin.agent-profiles` checks all four Nix owners and runs the fixtures. Linux CI builds the matching x86_64-linux check.
- In Pi, run `/subagents` and confirm the selected profile. Dispatch a no-tools review and inspect its actual backend, model and attempts. Repeat with a read-only task to check permission/tool parity. These are credentialed live checks, separate from fixtures.
