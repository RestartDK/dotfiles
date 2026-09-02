### Opening a PR

Invoked at the end of every other playbook.

**Worktree.** Work from a git worktree off main; subagents inherit it. Multiple subagent tasks on the same branch each get their own worktree, or `git fetch && git reset --hard origin/<branch>` between them. Dirty branch with unrelated work: patch out, fresh worktree, apply. Snarled worktree: reset from main, redo minimally.

**Ticket.** When the Linear MCP is connected, every PR carries a Linear issue. The task arrived without one: create it before branching, so the branch follows `<handle>/<ticket-id>` instead of a floating description. Production bugs get the `Bug` label and an incident writeup (root cause, evidence, affected identifiers). When the PR opens, attach the PR link to the issue and move the issue to In Review. Park out-of-scope follow-ups as issue checklist items, not chat messages. Linear not connected: skip this step and note the missing ticket in the PR description.

**Commits.** Commit liberally; rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit; new commit when separable.

**PRs.** Run the **unslop** skill over the diff-facing prose before commit. Run `/no-comments` before review. Write every PR title, PR description, and commit body with `/technical-writing`, then apply `/unslop`. Apply every technical-writing layer except Diátaxis. Use one word for each action, keep articles, and avoid `-ing` when a plain verb works.

**Titles.** Use Conventional Commits in the form `type(scope): subject`. Use `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf` as the type. Use the changed area, such as `server` or `dstack-mode`, as the scope. Keep the subject short and imperative. Apply the same `/technical-writing` and `/unslop` pass as the body. Name a real symbol when one carries the change. For example, `fix(dstack): retarget opening-a-pr babysit trigger`. Do not add a trailing period.

**Descriptions.** Use these sections in order. Drop a section when it is empty.

- `## Why`. State the intent and why this approach fits.
- `## Scope`. State facts from the diff. Name real symbols and paths. Name both sides of a rename or retarget. State what is in and out when the boundary matters.
- `## Tradeoffs`. State real choices only. Skip this section when there are none.
- `## Blast Radius`. State who and what the change touches. Explain why the change is safe or risky. If main is red without the fix, name the continuing cost.
- `## Verification`. State how you ran each check and its rigor. Name the real path, such as the live demo surface (headless chromium screenshot, browser automation, or the CLI itself) or the targeted tests. State the outcome of each check, not only the command name.

After these sections, attach videos or screenshots when they prove a claim. UI changes always have a claim to prove: attach the decisive before/after frames. When the host cannot inline images into the body through its API, upload the frames to the Linear issue with the attachment upload flow (`prepare_attachment_upload`, PUT, `create_attachment_from_upload`) and link them from the body. Do not use `## Summary` or `## Test plan` boilerplate. A commit body does not restate its subject.

**Size and stacks.** Prefer five narrow PRs to one large PR. Stack follow-ups with Graphite (`gt`), and keep the ordered stack visible to reviewers. Branch from main only for independent work. Rebase on `main` before substantial stack work.

**Readiness.** Open every PR ready, never as a draft. Cloud-agent PR tools default to draft, so set `draft: false` on every PR creation call. If a PR still opens as a draft, run the host's ready command, such as `gh pr ready <number>`. Run `gh pr view <number>` before you refer to PR status.

**Babysit.** Every PR you open hands off to `~/.agents/skills/dstack/dstack-mode/playbooks/babysit.md` in `drive` mode until it reports `READY`, with the review bot's score topped out when the repo runs one. Post the URL, then start the babysit in the same turn. For a stack, open the whole stack first, then babysit from the root. Push back when feedback drifts from intent.

A subagent that opens a PR runs `interrogate`, `unslop`, and `no-comments`. It returns the URL and does not babysit; the parent starts the babysit. Return to the parent.
