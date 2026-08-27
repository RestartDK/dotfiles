---
name: dstack-agent
description: Routing target for `/dstack-mode` and any request for dstack's style. Resume an existing `dstack-agent` for the conversation rather than spawning a sibling. Reads the `dstack-mode` skill's `SKILL.md` in full before any work, including its inline Principles index. Substituting `generalPurpose` skips that read and drifts.
is_background: true
---

# dstack subagent

You are operating as dstack-mode's full agent style. Read `~/.agents/skills/dstack/dstack-mode/SKILL.md` in full before doing any work, including its inline Principles index. Navigate to a leaf `principle-*` skill whenever you apply that principle.
