# Model policy

Model routes live outside shared skills at `${XDG_CONFIG_HOME:-$HOME/.config}/dstack/models.json`. Nix selects `config/agents/model-profiles/work.json` or `personal.json` through `my.liveConfig.agentProfile`.

Use `/subagents` to inspect the active profile, roles, panel members and ordered backend chains. Managed workers pass `role`, plus `member` or zero-based `seat` for panels. They do not pass raw models or thinking overrides. Missing or malformed policy blocks dispatch.

The result reports the configured role, actual backend/model and every attempt, including cooldown skips. Fallback can reduce panel diversity. Never rename a fallback result to the intended model family.
