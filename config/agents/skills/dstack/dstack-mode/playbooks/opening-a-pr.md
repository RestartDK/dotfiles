### Opening a PR

Invoked at the end of every other playbook.

**Worktree.** Give each PR one owned checkout/workspace and each branch one writer. Separate writable workers onto their own branches and integrate their reviewed patches through the lead. Read-only reviewers can share the checkout. Preserve unrelated changes and live-symlinked configuration; never reset or switch that checkout merely to prepare a PR. Transfer only the task diff to an isolated checkout when needed. A shared-resource lease covers one bounded mutation, never an approval wait, CI wait, or manual release FIFO.

**Repository rules.** Read `AGENTS.md` and the repo plugin before branching or submission. They own required validation, tracker workflow, branch naming, and any ticket-shaped title. Connected MCPs do not create requirements for other repositories.

**Commits.** Commit liberally; rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit; new commit when separable.

**PRs.** Run the **unslop** skill over the diff-facing prose before commit. Run `/no-comments` before review. Write every PR title, PR description, and commit body with `/technical-writing`, then apply `/unslop`. Apply every technical-writing layer except Diátaxis. Use one word for each action, keep articles, and avoid `-ing` when a plain verb works.

**Titles.** Use Conventional Commits in the form `type(scope): subject`, following the repository's scope rule. Otherwise use the changed area, such as `dstack`. Use `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf`. Keep the subject short and imperative, apply `/technical-writing` and `/unslop`, and name a real symbol when useful. Do not add a trailing period.

**Descriptions.** Write for the teammate who reviews between two meetings. Use three or four short paragraphs, without routine section headers. A reviewer should know what changed, why, and where to look in under a minute. Follow the repository's authoring skill when it provides one. A description never carries the `[🫩 Daniel's Agent]` prefix, which marks agent comments and review bodies for the watcher and does not belong on the change itself.

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

**Readiness.** Apply `AGENTS.md`'s pre-submission requirements, not an extra shared full-suite gate. Open ready unless the user requested a draft, and report remote CI as pending until observed. A ready label is not proof of green CI. Cloud tools may default to draft, so set the requested state explicitly and verify it with the host's PR view command.

**Delivery.** Check the parent goal's input-to-outcome proof on the matching built revision. Verify the actual native stack membership and base branches, not a list of PR links. Each PR keeps its owned checkout/workspace. A preview must be healthy and serve the intended revision. Missing proof or delivery checks remain explicit gaps; a worker summary or green CI cannot close them.

**Babysit.** Every PR you open hands off to `~/.agents/skills/dstack/dstack-mode/playbooks/babysit.md` in `drive` mode through confirmed merge and verified task-resource cleanup. `READY`, topped-out review scores, approval waits, and queue entry do not end the watch. Closure without merge also triggers cleanup and is reported as closed. Post the URL, then start the babysit in the same turn. For a stack, open the whole stack first, then babysit from the root. Carry the preview checkout, namespace, owned resources, and teardown commands into the handoff. Babysitting does not authorize merging. Push back when feedback drifts from intent.

A subagent that opens a PR applies the mode's risk-based independent review gate, `unslop`, and `no-comments`. It returns the URL and does not babysit; the parent starts the babysit. Return to the parent.
