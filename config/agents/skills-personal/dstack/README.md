# dstack

Daniel's engineering stack: principles, primitives, playbooks, agents, and scripts for pi and Cursor. Heavily adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) (MIT, Lauren Tan; `LICENSE.pstack`), pinned adaptation base `799151d`.

## Layers

1. **Principles** (`principle-*/`). 25 always-on rules; 21 adapted from pstack, 4 mine (`concise`, `self-explaining-code`, `design-system-first`, `show-me`). Never invoked directly; their names are the steering vocabulary. Cited only with the decision they changed.
2. **Primitives** (`skills/`). General workflows that grow over time: how, why, recall, architect, arena, swarm, interrogate, unslop, bro, teach, technical-writing, tdd, figure-it-out, reflect, show-me-your-work, automate-me, blast-radius, no-comments, typescript-best-practices.
3. **Applications** (`skills/`, migrated personal skills + each repo's `.agents/skills/`). Specific jobs that cite primitives.
4. **Playbooks** (`dstack-mode/playbooks/`, 15). Task-shaped sequences composing the layers. Steps are copied verbatim into todos; skips carry `skip: <reason>`.
5. **Agents** (`agents/`). `dstack-agent` (delegation inherits the mode), `comment-sicko` (read-only comment reviewer).
6. **Scripts + guide**. `dstack-mode/scripts/{stack-up.sh,watch-pr,sync.sh}`, `GUIDE.md` for the human.

## Entry points

- `/dstack <task>` in pi (prompt template forces a full mode read).
- The stickiness line in `~/.pi/agent/AGENTS.md` routes non-trivial work here automatically.
- One router: `dstack-mode/SKILL.md`. Everything else is reached through it.

## Repo layers

A repo adds `.agents/skills/dstack-<repo>/` with `references/` (principle carve-outs, stack tooling). Cobb's is `~/cobb/.agents/skills/dstack-cobb/`. Vendor the full stack into a repo for cloud agents with `dstack-mode/scripts/sync.sh <repo-root>` (team decision per repo).

## Model roles

`models.md`. Defaults: mechanical code → kimi-k3 (fireworks), precise-spec code → gpt-5.6-sol, judgment/prose/review → anthropic/claude-fable-5:xhigh.

## Deferred from pstack, deliberately

`orchestrate` + the orch CLI, `autopilot-full`/`autopilot-stack`, `autonomous-run` (folded into the mode's Autonomy section), `multi-phase-plan` + check-plan.mjs, `visual-parity`, `worktree-cleanup` + worktree-audit.sh, `runtime-forensics`/`trace-forensics`, `authoring-a-skill`, `create/maintain-verification-skill`, `setup-pstack` (pattern noted in models.md), benny. Adopt when the need shows up; the pinned pstack commit has the sources.
