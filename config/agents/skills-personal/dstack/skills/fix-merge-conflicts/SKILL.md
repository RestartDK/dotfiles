---
name: fix-merge-conflicts
description: Resolve merge conflicts non-interactively, validate build and tests, and finalize conflict resolution
---

# Fix merge conflicts

dstack wiring: invoked from `dstack-mode/playbooks/babysit.md` step order (conflicts before threads before CI).

## Trigger

Branch has unresolved merge conflicts and needs a reliable path to a buildable state.

For a GitHub native stack, read `~/.agents/skills/dstack/dstack-mode/references/github-stacks.md`. An explicit conflict-resolution request authorizes the stack rebase. Check `gh stack view --short`, save the current branch heads, and confirm that no affected PR is queued. Run `gh stack rebase` to rebase the stack onto its configured trunk, then follow the workflow below for each conflict. Use `gh stack rebase --continue` after staging each resolution, or `gh stack rebase --abort` if the resolution cannot proceed.

## Workflow

1. Detect all conflicting files from git status and conflict markers.
2. Resolve each conflict with minimal, correctness-first edits.
3. Prefer preserving both sides when safe. Otherwise, choose the variant that compiles and keeps public behavior stable.
4. Regenerate lockfiles with package manager tools instead of hand-editing.
5. Run compile, lint, and relevant tests.
6. Stage resolved files and summarize key decisions.

## Guardrails

- Keep changes minimal and readable.
- Do not leave conflict markers in any file.
- Avoid broad refactors while resolving conflicts.
- Do not push or tag during conflict resolution. After resolution and validation, return to the caller. If the user authorized updating the PRs, the caller publishes the stack with `gh stack push` and checks each remote head.

## Output

- Files resolved
- Notable resolution choices
- Build/test outcome
