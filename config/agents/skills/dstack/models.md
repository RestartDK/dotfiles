# Model policy

Model routes live outside shared skills at the host's `~/.config/dstack/models.json`, or its explicitly configured policy path. Nix selects `config/agents/model-profiles/work.json` or `personal.json` through `my.ai.profile`.

Read the policy for the active profile, roles, panel members, and ordered backend chains before each dispatch. Select the workflow's role and an explicit member or zero-based seat for panels. Resolve that selection into the native provider, model, and reasoning-effort flags through the [native hc contract](dstack-mode/references/native-agents.md). Role names are policy inputs, not arguments to a removed delegation extension.

Missing or malformed policy blocks launch. Never override a role, inherit the parent's model, or guess an equivalent backend. Only the route's ordered entries authorize fallback.

Record the configured role, selected panel member, actual provider and model, effort, and every attempt. Fallback can reduce panel diversity. Never rename a fallback result to the intended model family.
