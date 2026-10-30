# Agent model profiles

Nix selects `work.json` or `personal.json` with `my.ai.profile`. The standard Mac uses personal. Twin Mac and the Cobb bridge use work. The selected file is live-linked at `$XDG_CONFIG_HOME/dstack/models.json`, or `~/.config/dstack/models.json` when XDG_CONFIG_HOME is unset.

The file names the active profile, roles, panel members and backend chains. Each dispatch reloads it. Project settings cannot replace it. Missing, malformed or incomplete policy stops dispatch.

```json
{"agent":"dstack-agent","role":"feature","task":"Implement the scoped change"}
{"agent":"dstack-agent","role":"arena-runners","member":"deepseek","task":"Review the design"}
{"agent":"comment-sicko","role":"review","task":"Review the current diff"}
```

Panels require `member` or a zero-based `seat`, never both. Managed dstack agents require roles. Ad-hoc `model` requests must match a declared route including effort. `thinking` overrides and combined `role`/`model` inputs are rejected.

The work profile uses its existing `sol` route for prose, judgment, review and synthesis. Neither profile declares a Mimo or Opus route or allows the native Anthropic provider.

## Native Pi parents

The parent uses the profile's parent route. Work uses `sol` (`openai/gpt-6.1-sol` at `xhigh`); personal uses `deepseek` (`opencode-go/deepseek-v4.1-flash` at `high`, falling back to `openrouter/deepseek/deepseek-v4.1-flash`). The parent uses the head of its native Pi route; the rest of the chain is the fallback used by role dispatch. Session-local compatible thinking changes remain available to parents. Each worker runs the exact target its role resolves to. Pi may normalize a capability gap upward, such as GLM `xhigh` to `max`; implicit parent downgrades and unrelated effective levels are blocked.

`packages/pi-profiled` patches Pi 0.99.1 before compiling its Bun executable. The core runtime checks native requests even with extensions disabled, including retries, compaction and branch summaries. It rejects replacement transports, incompatible endpoints and transformed wire models. This is not a sandbox for arbitrary extension or shell code making its own requests.

Explicit selections require an exact provider and model. Any catalog model on a pinned provider transport (`openai`, `opencode-go`, `fireworks`, `openrouter`, `anthropic`, `ollama`) is selectable; the policy still blocks provider API or endpoint substitution within a transport. Missing authentication, unresolved catalog entries and effort downgrades never select another model. Pi loads `models-store.json` as well as its pinned static catalog. Both declared DeepSeek IDs exist in the observed cache; an older static catalog alone does not make them unavailable. Fireworks DeepSeek uses `anthropic-messages` at `https://api.fireworks.ai/inference`. Work API success still requires the matching credentials. Restored history must carry the same profile marker. Older unmarked sessions and cross-profile sessions require a new session.

The JSON policy stays live-editable. Changes to the compiled policy library or core patch require rebuilding `pi-profiled`. Default provider, model and thinking settings no longer override the profile's parent default.

## Worker sessions

Each consumer resolves a role to one exact provider, model and effort, and reports the backend it actually used. Raw `model` overrides must match a declared route including effort. `thinking` overrides and combined `role`/`model` inputs are rejected. A route's fallback chain stays declared in the policy; the consumer reports every attempt instead of renaming a fallback to the intended family.

## Checks

- `tests/pi-profiled/cached-models.ts` contains only the three public Fireworks DeepSeek, OpenRouter DeepSeek and GLM model records observed in the local Pi cache. Tests load them through Pi's native catalog store, use fake credentials and send no CLI prompts. SDK serializer checks replace the network transport. No private cache or authentication data is included.
- `bun test tests/agent-profiles` runs the policy tests without provider credentials.
- `nix build --no-link .#checks.aarch64-darwin.agent-profiles` checks all four Nix owners, their enforced Pi packages and the profiles. The package build also runs the strict production and full test typecheck against the patched SDK and source-emitted policy declarations, patched SDK tests and rebuilt CLI tests without credentials. Linux CI builds the matching x86_64-linux check.
- Confirm the selected profile by reading the policy file. When a delegation tool is available, dispatch a no-tools review and inspect its actual backend, model and attempts. Repeat with a read-only task to check permission/tool parity. These are credentialed live checks, separate from the offline suites.
