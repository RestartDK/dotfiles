# Agent model profiles

Nix selects `work.json` or `personal.json` with `my.ai.profile`. The standard Mac uses personal. Twin Mac, Twin Home Manager and the Cobb bridge use work. The selected file is live-linked at `$XDG_CONFIG_HOME/dstack/models.json`, or `~/.config/dstack/models.json` when XDG_CONFIG_HOME is unset.

`/subagents` shows the active profile, roles, panel members and backend chains. The dispatcher reloads this global file for each call. Project settings cannot replace it. Missing, malformed or incomplete policy stops dispatch.

```json
{"agent":"dstack-agent","role":"feature","task":"Implement the scoped change"}
{"agent":"dstack-agent","role":"arena-runners","member":"fable","task":"Review the design"}
{"agent":"comment-sicko","role":"review","task":"Review the current diff"}
```

Panels require `member` or a zero-based `seat`, never both. Managed dstack agents require roles. Ad-hoc `model` requests must match a declared route including effort and cannot bypass subscription priority. `thinking` overrides and combined `role`/`model` inputs are rejected.

## Native Pi parents

The parent uses the profile's parent route. Work uses `astra` (`openai-codex/gpt-6-astra` at `xhigh`); personal uses `deepseek` (`openrouter/deepseek/deepseek-v4.1-flash` at `max`). Every route is a native Pi target and the parent chain is single-hop. Session-local compatible thinking changes remain available to parents. Workers retain their role's exact target and declared effort. Pi may normalize a capability gap upward, such as GLM `xhigh` to `max`. Downgrades and unrelated effective levels are blocked.

`packages/pi-profiled` patches Pi 0.85.1 before compiling its Bun executable. The core runtime checks native requests even with extensions disabled, including retries, compaction and branch summaries. It rejects replacement transports, incompatible endpoints and transformed wire models. This is not a sandbox for arbitrary extension or shell code making its own requests.

Explicit selections require an exact provider and model. Any catalog model on a pinned provider transport (`openai-codex`, `fireworks`, `openrouter`, `ollama`) is selectable; the policy still blocks provider API or endpoint substitution within a transport. Missing authentication, unresolved catalog entries and effort downgrades never select another model. Pi loads `models-store.json` as well as its pinned static catalog. Both declared DeepSeek IDs exist in the observed cache; an older static catalog alone does not make them unavailable. Fireworks DeepSeek uses `anthropic-messages` at `https://api.fireworks.ai/inference`. Work API success still requires the matching credentials. Restored history must carry the same profile marker. Older unmarked sessions and cross-profile sessions require a new session.

The JSON policy stays live-editable. Changes to the compiled policy library or core patch require rebuilding `pi-profiled`. Default provider, model and thinking settings no longer override the profile's parent default.

## Worker sessions

Fable resolves to Pi Codex Astra in both profiles. A worker runs as an in-process Pi SDK session with its route's exact provider, model and effort, the preset system prompt, the requested tools and `codemode`. Results report the actual model and every attempt.

Recognized native HTTP and provider error envelopes classify as auth, quota or unavailable. Fallback requires a matching terminal provider failure before any tool use. Any tool use, including a read, closes fallback. Task/test failures, unknown errors, scope mismatches and cancellation never advance. The parent must reconcile partial work before retrying. Output is bounded to 50 KiB. Stderr stays empty because workers run in-process.

Explicit `tools: []` still activates `codemode` only. Global and ancestor project instructions use AGENTS.override.md, AGENTS.md, then CLAUDE.md precedence per directory. They join the preset instructions and the explicit system prompt in the worker's session. Tools named in those instructions but not requested stay unavailable.

Each endpoint is attempted at most once per chain. A process-local cache skips recently unavailable endpoints, including the final endpoint. Otherwise the cooldown is 60 seconds. There is no daemon, lockfile or retry loop.

## Checks

- `tests/pi-profiled/cached-models.ts` contains only the three public Fireworks DeepSeek, OpenRouter DeepSeek and GLM model records observed in the local Pi cache. Tests load them through Pi's native catalog store, use fake credentials and send no CLI prompts. SDK serializer checks replace the network transport. No private cache or authentication data is included.
- `bun test tests/agent-profiles` runs policy tests and runner tests through the fake session seam without provider credentials.
- `nix build --no-link .#checks.aarch64-darwin.agent-profiles` checks all four Nix owners, their enforced Pi packages and the profiles. The package build also runs the strict production and full test typecheck against the patched SDK and source-emitted policy declarations, patched SDK tests and rebuilt CLI tests without credentials. Linux CI builds the matching x86_64-linux check.
- In Pi, run `/subagents` and confirm the selected profile. Dispatch a no-tools review and inspect its actual backend, model and attempts. Repeat with a read-only task to check permission/tool parity. These are credentialed live checks, separate from the offline suites.
