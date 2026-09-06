---
name: split-to-prs
description: >-
  Split current work into small reviewable PRs, using Graphite when available
  and stacking only when changes truly depend on each other, with a Linear
  issue per PR. Use when the user asks to split a chat, set of changes, branch,
  or PR.
---
# Split to PRs

dstack wiring: shapes stacks per **principle-sequence-verifiable-units**; each resulting PR ships via `dstack-mode/playbooks/opening-a-pr.md`.

Turn one pile of work into a few small PRs. Use Graphite when it is available, authenticated, and synced for the repository; otherwise use Git and the hosting provider directly.

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
- **Dependent slices** (a slice cannot build or make sense without another): one stack in dependency order when Graphite is available. Without Graphite, prepare and ship them sequentially from the root, rebasing each next slice onto trunk after its dependency lands. Do not stack out of convenience — stack only when the dependency is real.
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

- Independent slices: from trunk, create one branch per slice and commit only the planned files or hunks. Use `gt checkout` and `gt create` when Graphite is available; otherwise use normal Git branches.

  ```bash
  git switch main
  git switch -c <branch-name>
  git add <planned files>   # or git add -p for hunks
  git commit -m "feat: ..."
  ```

- Dependent slices with Graphite: build the stack bottom-up. Create the base branch from trunk, then create each dependent branch on top of the previous one with `gt create`, staging only that slice's files. Run `gt restack` if the stack needs realignment.

- Without Graphite: prepare the root slice first, push it, and open it through the hosting provider. After it merges, rebase the next approved slice onto trunk and repeat. Do not make Graphite setup a prerequisite for delivery.

- Submit through the available path: `gt submit` or `gt submit --stack` when Graphite is available; otherwise push with Git and use the hosting provider, such as `gh pr create` on GitHub. Reference the Linear issue in each PR body (e.g. `Fixes ENG-123`) and use commitlint-compatible PR titles.

## 4. Report back

Keep it short: PR titles, PR URLs, and Linear issue IDs, plus the stack structure if any and anything left on the starting branch or working tree. Do not delete the backup ref or original branch unless the user asks.
