---
name: split-to-prs
description: >-
  Split current work into small reviewable PRs using Graphite, stacking only
  when changes truly depend on each other, with a Linear issue per PR. Use when
  the user asks to split a chat, set of changes, branch, or PR.
---
# Split to PRs (Graphite)

Turn one pile of work into a few small PRs managed with the Graphite CLI (`gt`).

## Hard rules

- Do not create branches, commit, push, or open PRs until the user approves the split plan.
- Never discard user work. No destructive git commands (`reset --hard`, `clean -fdx`, branch deletion, force-push, history rewrite) without explicit approval.
- Always save a recoverable snapshot before moving work around. This often starts from dirty work on `main`, so do not assume there is already a safe branch.
- Stage only named files or hunks. No `git add .` / `git add -A`.
- Every split PR gets its own Linear issue. Create the issue before opening the PR and link it in the PR body.

## 1. Check the state

Compare the current work to the repo's trunk, including committed and uncommitted changes. Check `gt log short` to understand any existing stack. Summarize the real slices you see, and use the chat history to recover intent.

## 2. Propose the split

Use judgment on detail. Usually PR titles are enough. Add a one-line scope note only when a title is unclear. Show a Mermaid diagram when there are multiple slices.

Decide stacking per slice:

- **Independent slices** (compile, test, and review standalone): separate branches directly off trunk, each its own PR.
- **Dependent slices** (a slice cannot build or make sense without another): one Graphite stack in dependency order. Do not stack out of convenience — stack only when the dependency is real.
- A mix is fine: e.g. two independent PRs off trunk plus a two-PR stack.

Include the planned Linear issue titles alongside the PR titles.

Ask for approval before starting.

## 3. Execute the split

- If there is uncommitted work, save a recoverable snapshot without changing the working tree:

  ```bash
  SHA=$(git stash create "pre-split")
  if [ -n "$SHA" ]; then
    git update-ref "refs/backup/pre-split-$(date +%s)" "$SHA"
  fi
  ```

- For each approved slice, create its Linear issue first (Linear MCP tools). Reuse an existing issue only if the user points to one.

- Independent slices: from trunk, create one branch per slice and commit only the planned files or hunks:

  ```bash
  gt checkout main
  git add <planned files>   # or git add -p for hunks
  gt create <branch-name> -m "feat: ..."
  ```

- Dependent slices: build the stack bottom-up. Create the base branch from trunk as above, then create each dependent branch on top of the previous one with `gt create`, staging only that slice's files. Run `gt restack` if the stack needs realignment.

- Submit with Graphite so PR relationships are correct: `gt submit` for a single branch, `gt submit --stack` from the top of a stack. Reference the Linear issue in each PR body (e.g. `Fixes ENG-123`) and use commitlint-compatible PR titles.

## 4. Report back

Keep it short: PR titles, PR URLs, and Linear issue IDs, plus the stack structure if any and anything left on the starting branch or working tree. Do not delete the backup ref or original branch unless the user asks.
