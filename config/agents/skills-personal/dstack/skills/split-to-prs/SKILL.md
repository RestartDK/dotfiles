---
name: split-to-prs
description: >-
  Split current work into small reviewable PRs, using GitHub native stacks via gh stack
  and stacking only when changes truly depend on each other, with a Linear
  issue per PR. Use when the user asks to split a chat, set of changes, branch,
  or PR.
---
# Split to PRs

dstack wiring: shapes stacks per **principle-sequence-verifiable-units**; each resulting PR ships via `dstack-mode/playbooks/opening-a-pr.md`.

Turn one pile of work into a few small PRs. On GitHub, use the official `github/gh-stack` extension for dependent slices. Read `~/.agents/skills/dstack/dstack-mode/references/github-stacks.md` for setup, submission, and merge limits. Use Git and `gh pr` for independent slices.

## Hard rules

- Do not create branches, commit, push, or open PRs until the user approves the split plan.
- Never discard user work. No destructive git commands (`reset --hard`, `clean -fdx`, branch deletion, force-push, history rewrite) without explicit approval.
- Always save a recoverable snapshot before moving work around. This often starts from dirty work on `main`, so do not assume there is already a safe branch.
- Stage only named files or hunks. No `git add .` / `git add -A`.
- Every split PR gets its own Linear issue. Create the issue before opening the PR and link it in the PR body.

## 1. Check the state

Compare the current work to the repo's trunk, including committed and uncommitted changes. Check `gh stack view --short` to understand an existing local stack. If the stack exists only on GitHub, inspect its PR bases with `gh pr view`. Defer `gh stack checkout <pr-url>` until the split is approved and the dirty work has a recoverable snapshot. Summarize the real slices you see, and use the chat history to recover intent.

## 2. Propose the split

Use judgment on detail. Usually PR titles are enough. Add a one-line scope note only when a title is unclear. Show a Mermaid diagram when there are multiple slices.

Decide stacking per slice:

- **Independent slices** (compile, test, and review standalone): separate branches directly off trunk, each its own PR.
- **Dependent slices** require another slice to build or make sense. Use one GitHub native stack in dependency order, with all branches in the same repository. If native stacks are unavailable, deliver the slices sequentially from trunk. Stack only when the dependency is real.
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

- Independent slices: from trunk, create one branch per slice and commit only the planned files or hunks. Use normal Git branches.

  ```bash
  git switch main
  git switch -c <branch-name>
  git add <planned files>   # or git add -p for hunks
  git commit -m "feat: ..."
  ```

- For dependent slices, build the stack bottom-up. Create the root with `gh stack init --base <trunk> <root-branch>`. Commit its planned files, then create each dependent branch with `gh stack add <child-branch>` and commit that slice. Use `gh stack rebase` only when realignment is authorized.

- Submit the approved stack with `gh stack submit --auto --open`, then set each title and body with `gh pr edit`. Omit `--open` only for an explicit draft request. For existing PRs with the intended bases, use `gh stack link <root-pr-url> <child-pr-url>` in bottom-to-top order.

- For independent PRs, push with Git and use `gh pr create`. If native stacks are unavailable, report the limitation and submit only the root slice. After it merges, rebase the next approved slice onto trunk, re-verify, and repeat.

- Reference the Linear issue in each PR body (e.g. `Fixes ENG-123`) and use commitlint-compatible PR titles.

## 4. Report back

Keep it short: PR titles, PR URLs, and Linear issue IDs, plus the stack structure if any and anything left on the starting branch or working tree. Do not delete the backup ref or original branch unless the user asks.
