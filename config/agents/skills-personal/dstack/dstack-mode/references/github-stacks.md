# Use GitHub native stacks

Use GitHub's official `github/gh-stack` extension for dependent PRs on GitHub. Keep independent PRs on separate branches off trunk. Native stacks are in public preview and require every branch to live in the same repository. Cross-fork stacks are not supported.

## Check the CLI

Run `gh extension list`, `gh stack --help`, and `gh auth status`. If the extension is missing, install it with `gh extension install github/gh-stack`. Check the installed command's help before using a flag. Report an unsupported command or unavailable server feature rather than inventing an equivalent.

`gh stack view --short` shows local branch order and PR status. Use `gh stack view --json` for machine-readable state. To adopt an existing remote stack, use `gh stack checkout <pr-url>` first. A PR URL avoids the numeric lookup that tries a stack number before a PR number.

Do not use `gh stack sync` as a status check. It fetches, rebases, pushes with force-with-lease, and updates the remote stack.

## Create and submit the stack

1. Create the root branch with `gh stack init --base <trunk> <root-branch>`.
2. Stage only the planned files or hunks with Git, then commit the root change.
3. Add the next branch with `gh stack add <child-branch>`, then stage and commit that layer. Repeat for each dependent change.
4. Submit the approved stack with `gh stack submit --auto --open`. This pushes every branch, creates PRs, updates their bases, and links the native stack.
5. Set each approved title and description with `gh pr edit <pr-number> --title <title> --body-file <path>`. Confirm the PR bases and ready state with `gh pr view` and `gh stack view`.

Without `--open`, non-interactive submission creates drafts. For an explicit draft request, omit `--open`. Do not use `gh stack add -A` or `-u` to sweep unrelated work into a commit.

For existing local branches, adopt them with `gh stack init --base <trunk> <root-branch> <child-branch>` in bottom-to-top order. To link existing PRs without local tracking, use `gh stack link <root-pr-url> <child-pr-url>` in that order. Check their bases first. Branch-name arguments can push branches and create PRs, so use PR URLs when the intent is only to link existing PRs.

Standalone PRs use `git push`, `gh pr create`, and `gh pr edit`. If native stacks are unavailable, report the limitation and deliver dependent slices sequentially from trunk. Do not treat an unlinked branch chain as a native stack or a safe merge queue.

## Update an authorized stack

Before a history rewrite, confirm the owning user's authorization, a clean worktree, and that no affected PR is queued. Save the branch heads so the original state is recoverable.

Run `gh stack rebase` to fetch trunk and rebase the stack bottom-up. Resolve conflicts, stage the resolved files, and use `gh stack rebase --continue`. Use `gh stack rebase --abort` to restore the pre-rebase branches if the resolution cannot proceed.

After validation, use `gh stack push` to publish an authorized restack without creating PRs. It uses per-branch force-with-lease checks, but its updates are not atomic. Inspect each remote head after a rejection before deciding what to retry.

`gh stack sync` combines fetch, rebase, push, and remote stack updates. Use it only when all those mutations are authorized, never during Babysit or while a merge queue drains. Do not pass `--prune` without approval to delete the merged local branches.

For a review fix confined to one owning branch, commit and push only that branch with Git. Escalate any required descendant rebase to the stack owner. `gh stack submit`, `push`, and `sync` are whole-stack operations, not branch-local fix commands.

## Merge only the verified prefix

Follow the Shipping playbook before any merge. Capture the PR order and head SHAs, then identify the highest contiguous verified PR above the root.

Use `gh stack merge <ceiling-pr-number> --yes --squash` when the repository uses squash merges. Select `--merge` or `--rebase` only if the repository permits that method. Confirm the argument identifies the chosen PR, not a stack number. A stack number or an omitted argument selects the whole stack and can include unverified work.

Without a merge queue, GitHub merges every PR through the chosen ceiling into the stack's base in one atomic operation. With a merge queue, GitHub enqueues the selected PRs together, but they can land in separate groups. The queue controls the merge method. Neither path bypasses repository rules.

Do not substitute `gh pr merge` or per-PR auto-merge for a dependent child's native stack merge. Those commands can merge the child into its parent branch. Use `gh pr merge` for a standalone PR or a verified root that currently targets trunk.

Confirm the selected PRs' merged or queued state on GitHub. A successful command or an `autoMergeRequest` field alone does not prove the native stack request is queued. Keep the frozen PR list until every selected PR is merged, even if GitHub retargets the remaining stack. Do not rewrite branches during that wait.

## Sources

- [Create stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-stacked-pull-requests).
- [Official gh-stack extension](https://github.com/github/gh-stack).
- [Stacked PR CLI commands](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands).
