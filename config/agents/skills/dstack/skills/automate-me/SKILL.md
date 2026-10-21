---
name: automate-me
description: "Use for \"automate me\", \"create/update/refresh my -mode skill\", \"turn/capture my preferences or working style into a skill\", or wanting agents to follow how the user works. Drafts or revises a personal -mode skill via the pi skill format + unslop, optionally pulling fresh evidence from recent transcripts."
disable-model-invocation: true
---

# Automate me

A guided flow for turning the user's working conventions into a skill agents will follow. The output is one `-mode` skill tailored to them (e.g. `jay-mode`, `priya-mode`).

This skill orchestrates three others: an inline mining pass (see step 1), skill authoring per the pi skill format (pi docs/skills.md), and the **unslop** skill (prose discipline). It sequences them; it doesn't replace them.

## Flow

### 0. Check for an existing skill

Search both roots recursively for `**/*-mode/SKILL.md` matching the user's handle, since mode skills live in a personal category directory (`.agents/skills/<handle>/`), not only at the top level. If one exists, resolve its versioned source before computing dates or editing (step 4). Then confirm intent with a structured question (unless they already said "update my skill" or similar):

- Update the existing skill (default for repeat runs)
- Start fresh (rare; ask why before doing it)

Update mode changes the rest of the flow:
- Step 1 mines only history since the skill was last edited (`git log -1 --format=%cI <path>`), per source. A source with no prior coverage gets an agreed baseline window instead of the file date.
- Step 2 asks what's changed or missing, not what to capture from zero.
- Step 4 edits the existing file in place. Preserve sections the user hasn't contradicted; revise ones with new evidence; add new sections only for genuinely new rules.

### 1. Scope the evidence, then mine it

A mode skill describes how the user works, so the evidence is wider than the current workspace and often wider than one machine. Confirm an explicit allowlist of hosts and workspaces before reading any transcript; ask once when the user has not supplied one, and name the other agent histories that exist locally (`~/.claude`, `~/.codex`, `~/.gemini`). Leave unapproved slugs untouched.

On one machine, pi sessions live at `~/.pi/agent/sessions/<cwd-slug>/` (slug = absolute cwd path with slashes turned into dashes). For each approved repository include its worktree slugs and any slug that extends a checkout path, since sessions started in a subdirectory get their own slug. Derive worktrees, don't guess: `git worktree list --porcelain | awk '/^worktree /{print $2}'`.

Across machines, use the **fleet** skill (`~/.agents/skills/dstack/skills/fleet/SKILL.md`) for target selection and transport: `fleet list --json`, `fleet check TARGET... --json`, then a `--dry-run` you inspect before `--execute`. Fleet carries argv commands, not files, and reachability is not proof that the payload succeeded. Extract a bounded digest per host with an argv payload over an approved glob (a `jq` or `rg` command printing dates, slugs, and user-authored text), mine the digest locally, and report unavailable hosts rather than substituting another.

Survey the digest for recurring patterns. Split the history into slices by host, workspace, and time, so one busy repository cannot fill every slice. Run parallel subagents, one per slice (3-4 is usually enough). Each slice mining subagent reads the paths the parent provides, looks for the signals below, and returns a short structured list of patterns it saw with evidence pointers. Cap each slice (for example, the most recent N sessions per workspace) so a large history cannot blow the context window. Default signals worth hunting:

- Response preferences (length, tone, format, "dumb it down" corrections)
- Delegation habits (subagents, models, specialized workflows, parallelism)
- Verification posture (what "done" means; unit tests vs live repro; reviewers)
- Code and prose discipline (style, principles cited, lint/format tools)
- Process conventions (worktrees, commits, PRs, review/merge tooling)
- Meta preferences (fixing skills mid-task, proposing new ones)

Cross-check across slices before elevating a signal. Patterns seen across independent hosts, workspaces, or time slices are high-confidence. A pattern that appears only because one repository fills every slice is repository-specific and belongs in that repository's layer, not the mode skill. Lone signals are weak and usually get dropped.

### 2. Ask the user directly

Mining misses intent that hasn't come up yet. Ask the user with structured multi-choice options rather than asking them to type from scratch. Lower cognitive load, higher hit rate.

Shape: one or two questions with 4-6 options each, `allow_multiple: true` for category questions. Start broad ("Which areas matter most?"), then follow up on selected areas with specific options. After the structured rounds, one free-form chat question catches anything the options missed.

Don't dump 20 questions. Two structured rounds plus one open question is usually enough.

### 3. Cluster findings

Group the combined signals into sections. Common ones (use only what applies):

- **Response style**: length, tone, format.
- **Autonomy**: how much to do without asking; MCP tool use.
- **Understand first**: which skills to reach for when scoping or investigating a change.
- **Subagents**: default, parallelism, model-to-task, specialized workflows.
- **Prose / code discipline**: principles, lint tools, style guides.
- **Review and verify**: repro posture, verification skills, live-testing tools.
- **Process**: git worktrees, commits, PRs, review/merge tooling.
- **Skills**: skill-authoring habits, fix-the-skill-first, proposing new skills.

The **dstack-mode** skill shows the shape. Read it for granularity. Don't copy its content; the user's rules are not the same as dstack-mode's.

### 4. Draft the skill

Use the pi skill format (pi docs/skills.md) to author the skill. Placement:

- Path: preserve an existing mode skill's category. For a new mode, use `.agents/skills/<handle>/<handle>-mode/SKILL.md` when the repo has an established personal category for that handle; otherwise default to `.agents/skills/<handle>-mode/SKILL.md` in the project, or the versioned source directory that deploys the user's personal skills.
- Source, not install. Resolve the deployed path before editing. A harness path may be a symlink into a live checkout or a generated copy, and two machines can differ. Read the symlink and the deployment config to find the versioned source, edit that, and report which kind each host used.
- Handle: the user's first name or chosen identifier.
- Frontmatter `description`: trigger on their name + `/<handle>-mode` + "work in their style", not on generic keywords like "write code" or "review PR".
- Frontmatter formatting: follow the pi skill frontmatter rules (docs/skills.md). Keep `description` as one YAML scalar; quote it or use `description: >-` with indented continuation lines when punctuation or wrapping requires it.
- Frontmatter `disable-model-invocation: true` by default. Mode skills are heavy and opinionated; they should only apply when the user explicitly invokes them (by name or slash command), not auto-trigger on description matching. Opt out only if the user explicitly wants their mode to apply on every turn.

### 5. Iterate on prose

Apply the **unslop** skill and the pi skill-authoring guidelines to every line. Both apply to any agent-read prose, not just skills.

Show the draft to the user and take feedback. Expect multiple iterations. Cut ruthlessly; a mode skill is not a manual.

### 6. Land it

Work in a worktree off main. Commit and open a PR so the user can review it. Don't push to main directly.

## Guardrails

- **Don't overfit to one conversation.** A preference stated once and contradicted another time is noise. Require multiple instances before codifying it.
- **Don't be clever.** Restating other skills' contents, inventing metaphors, or writing "poetic" prose for an agent reader is cost without benefit. Keep it operational.
- **Reference, don't inline.** Other skills the user relies on should appear as path references, not pasted excerpts. Same for any principle docs they maintain elsewhere.
- **Keep sections minimal.** Only add a section if the user has a specific, non-default rule there. "Communicate clearly" is not a section. "Short paragraphs. Tables when comparing options. Bullets only when items are genuinely parallel." is.
- **Name conventions generic.** Use "the user" or "the human" in imperatives, not the author's first name. Others may read or adopt the skill.
- **Don't force symmetry.** If a user has no process rules worth writing down, skip the Process section entirely. Sparse is fine; bloated is not.

## Evaluation

A `-mode` skill is subjective output. A test/iterate benchmark loop is not useful here. Vibe-check with the user: does it read like them? Did it miss anything? Then ship.

Run a description-optimization loop only if the skill's trigger accuracy turns out to be a problem in practice.

## When not to use

- User wants a task-specific skill (not working conventions): author it directly per the pi skill format, no mining required.
- User wants to capture one narrow workflow (e.g. "how I write commit messages"): that's a regular skill, not a mode skill.

## Reference files

- The **dstack-mode** skill: example of the output shape.
- The **unslop** skill: prose discipline for every line.
- the pi skill format (pi docs/skills.md): skill authoring process and writing guidelines.
