# agents

Source of truth for the global agent configuration. Home Manager links these into runtime paths, out of store, so edits are live on any host whose checkout is linked. Nothing here is a copy.

| path | deploys to | holds |
|---|---|---|
| `skills/` | `~/.agents/skills`, `~/.claude/skills` | every global skill: `dstack` (the bundle), `.system` (Codex system skills), vendor installs, and one directory per authored skill |
| `agents/` | `~/.agents/agents` | worker definitions for the `subagents` tool |
| `model-profiles/` | `~/.config/dstack/models.json` | per-profile role policy |
| `.skill-lock.json` | `~/.agents/.skill-lock.json` | provenance for vendor installs made by `npx skills` |

## Rules

- A global skill is a directory with a `SKILL.md`. The only other top-level entries allowed in `skills/` are `dstack` and `.system`.
- Vendor installs are tracked in `.skill-lock.json`. Authored skills are not listed there.
- Repo-specific skills live in the repo at `<repo>/.agents/skills/`, never here.
- Agent definitions are real files in `agents/`, not symlinks into the bundle.
- `tests/skills.sh` enforces the layout and the lock in both directions.
