### Opening a PR

Invoked at the end of every other playbook.

**Worktree.** Work from a git worktree off main; subagents inherit it. Multiple subagent tasks on the same branch each get their own worktree, or `git fetch && git reset --hard origin/<branch>` between them. Dirty branch with unrelated work: patch out, fresh worktree, apply. Snarled worktree: reset from main, redo minimally.

**Ticket.** When the Linear MCP is connected, every PR carries a Linear issue. The task arrived without one: create it before branching, so the branch follows `<handle>/<ticket-id>` instead of a floating description. Production bugs get the `Bug` label and an incident writeup (root cause, evidence, affected identifiers). When the PR opens, attach the PR link to the issue and move the issue to In Review. Park out-of-scope follow-ups as issue checklist items, not chat messages. Linear not connected: skip this step and note the missing ticket in the PR description.

**Commits.** Commit liberally; rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit; new commit when separable.

**PRs.** Run the **unslop** skill over the diff-facing prose before commit. Run `/no-comments` before review. Write every PR title, PR description, and commit body with `/technical-writing`, then apply `/unslop`. Apply every technical-writing layer except Diátaxis. Use one word for each action, keep articles, and avoid `-ing` when a plain verb works.

**Titles.** Use Conventional Commits in the form `type(scope): subject`. Use `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf` as the type. **When the Linear MCP is connected, the scope is the ticket id in lowercase: `feat(twi-7122): scaffold store version manifests`.** The ticket exists by the time the PR opens (the Ticket step above created it), so a title without it is a miss, not a style choice; put the changed area in the subject if the reader needs it. Only when Linear is not connected does the changed area, such as `server` or `dstack-mode`, take the scope. Keep the subject short and imperative. Apply the same `/technical-writing` and `/unslop` pass as the body. Name a real symbol when one carries the change. For example, `fix(twi-6734): retarget opening-a-pr babysit trigger` with a ticket, `fix(dstack): retarget opening-a-pr babysit trigger` without one. Do not add a trailing period.

**Descriptions.** Write for the teammate who reviews between two meetings. Use three or four short paragraphs, without routine section headers. A reviewer should know what changed, why, and where to look in under a minute. Follow the repository's authoring skill when it provides one.

1. Open with two plain sentences about the change and the problem it solves. No identifiers, file paths, labels, or headers. A colleague from another team should understand both without opening the diff.
2. Explain the fix in plain language. Include only what the diff cannot show, plus deliberate limitations, affected users, compatibility risks, and real tradeoffs when they matter.
3. Give generated files, moved code, or incidental cleanup one line so reviewers can skip them. Omit this paragraph when there is none.
4. End with one sentence of observed behavior that proves the change. Name the surface and outcome, not a verification ledger. CI and review status are already visible.

A large diff earns a short "How to read this PR" guide. Name what to skip and the few files worth attention, with one reason each. Numbers should shrink the reviewer's job, not decorate the claim. If the guide cannot stay legible, split the PR by layer. A production investigation names its source identifiers after the opening, wherever they explain the problem. Do not add a section just to hold them.

Write from the net diff against the merge base, not intermediate commits or the base branch's current tip. Describe only changes that the PR introduces. Lead with the capability, not its construction. An ordinary PR needs the opening, evidence when relevant, and at most two more short paragraphs.

Keep the body current by rewriting it, not appending review rounds. Read the existing body first and preserve handwritten screenshots, videos, and links. Reply to review findings in their threads. Vary sentence length, code-format identifiers, and use bold sparingly. Avoid file tours, boilerplate "Summary" or "Test plan" sections, and a "TL;DR" prefix. A commit body does not restate its subject.

**Evidence.** Place one evidence block directly below the opening. Prefer a two-column table headed **Before** and **After**, rather than separate full-width attachments. Honor the requested medium. Otherwise, use screenshots for static appearance, videos for interactions, and measured tables for performance or evaluation results. Capture the same scenario with matching framing and viewport dimensions. The before capture must show the real baseline, not a reconstruction made by changing CSS or state. If no honest baseline exists, label the evidence **After** and explain the limitation. Do not invent a before state or attach both formats without a separate claim to prove.

Use the repository's capture and publication tools. Confirm images render and videos play inside the labelled cells on the host. Keep preview links immediately below the evidence, without an intervening heading. Replace stale evidence on a new recording instead of appending another block. Omit visual evidence when the change has no visible behavior. If the host cannot embed the requested media, state the limitation and use clearly labelled durable links.

**Size and stacks.** Prefer five narrow PRs to one large PR. Stack follow-ups only when they depend on each other, and keep the order visible to reviewers. Branch from main only for independent work. Rebase on `main` before substantial stack work.

**Submission host.** On GitHub, use the official `github/gh-stack` extension for dependent PRs. Read `~/.agents/skills/dstack/dstack-mode/references/github-stacks.md` before stack work. Submit the approved stack with `gh stack submit --auto --open`, then set each title and body with `gh pr edit`. Omit `--open` only for an explicit draft request. For standalone PRs, push with Git and use `gh pr create` or `gh pr edit`. If native stacks are unavailable, report the limitation and deliver dependent slices sequentially from trunk. For other hosts, use their PR tooling without assuming GitHub stack semantics.

**Readiness.** Open every PR ready unless he asked for a draft. An explicit draft request opens the PR now, after the repo's seconds-long pre-push checks, with full CI running before it is marked ready; an unrelated failing gate or another session's edits do not hold it back. Cloud-agent PR tools default to draft, so set `draft: false` on every PR creation call he did not ask to be a draft. If a PR still opens as a draft he did not ask for, run the host's ready command, such as `gh pr ready <number>`. Run `gh pr view <number>` before you refer to PR status.

**Babysit.** Every PR you open hands off to `~/.agents/skills/dstack/dstack-mode/playbooks/babysit.md` in `drive` mode through confirmed merge and verified task-resource cleanup. `READY`, topped-out review scores, approval waits, and queue entry do not end the watch. Closure without merge also triggers cleanup and is reported as closed. Post the URL, then start the babysit in the same turn. For a stack, open the whole stack first, then babysit from the root. Carry the preview checkout, namespace, owned resources, and teardown commands into the handoff. Babysitting does not authorize merging. Push back when feedback drifts from intent.

A subagent that opens a PR runs `interrogate`, `unslop`, and `no-comments`. It returns the URL and does not babysit; the parent starts the babysit. Return to the parent.
