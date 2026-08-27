---
name: review-pr
description: Review a coworker's GitHub pull request given a PR number or GitHub PR URL, using the thermo-nuclear code quality review standard. Use for reviewing someone else's PR, "review PR #123", "review this PR <link>", or coworker code review.
---

# Review Pull Request

dstack wiring: for contested designs, escalate to the **interrogate** primitive; PR mechanics live in `dstack-mode/playbooks/opening-a-pr.md`.

Review a coworker's pull request end to end: resolve the PR reference, fetch the diff and context, apply the full review standard, and produce coworker-facing review feedback.

## Trigger

The user provides a PR reference in any of these forms:

- A bare number: `123`
- Repo-qualified: `org/repo#123` or `org/repo 123`
- A full GitHub URL: `https://github.com/org/repo/pull/123`

## Workflow

1. **Normalize the input.**
   - Bare number: use the current repository (`gh repo view --json nameWithOwner`).
   - Repo-qualified or URL: extract owner, repo, and PR number.
   - If the reference cannot be parsed, ask the user instead of guessing.

2. **Fetch PR metadata and diff.**
   - Metadata: `gh pr view <number> --repo <owner/repo> --json number,title,url,author,headRefName,baseRefName,body,additions,deletions,changedFiles`
   - Diff: `gh pr diff <number> --repo <owner/repo>`
   - If the diff is large, fetch the per-file list and read the most consequential files in full, not just the diff hunks.
   - Read the PR description and any linked issue so the review judges the change against its stated intent.

3. **Fetch existing review feedback first.**
   - Inline comments: `gh api repos/<owner>/<repo>/pulls/<number>/comments --paginate`
   - Review summaries: `gh api repos/<owner>/<repo>/pulls/<number>/reviews --paginate`
   - Do not repeat findings that bots (greptile, copilot) or human reviewers already raised and the author has addressed or acknowledged. Reference or endorse existing threads instead of duplicating them, and spend the review budget on what nobody has covered yet.

4. **Check out the PR locally when deeper inspection is needed.**
   - Prefer working in the current repo checkout if it is the same repository: `gh pr checkout <number>`.
   - Local checkout enables: reading surrounding code the diff omits, verifying claimed invariants, running the build/tests, and checking whether suggested restructures actually typecheck.
   - When the PR is in the cobb repository, follow the repo's AGENTS.md rules for any commands (direnv, workspace-wide checks, canonical clippy).
   - Do not leave the user's working copy on the PR branch when done; return to the original branch.

5. **Apply the review standard.**
   - Load the `thermo-nuclear-code-quality-review` skill and apply it in full: core prompt, non-negotiable standards, language-specific standards (Rust and frontend/TypeScript), primary review questions, flag list, preferred remedies, and approval bar.
   - Additionally apply the target repository's own contribution rules (e.g. AGENTS.md) when reviewing — a PR that violates explicit repo rules is a blocker even if the code is otherwise clean.

6. **Verify before accusing.**
   - Every blocking claim must be confirmed against the actual code, not inferred from the diff in isolation. Read enough surrounding context to know the claim is true.
   - If a suspected issue depends on runtime behavior you cannot confirm locally, phrase it as a question with the evidence, not an assertion.

## Output

Produce review feedback formatted for a coworker audience:

- **Verdict**: approve / approve with comments / request changes, with a one-paragraph justification.
- **Blocking issues**: ordered by severity. Each with file/line reference, what the problem is, why it matters, and the concrete remedy. Quote the offending code briefly.
- **Non-blocking suggestions**: genuine improvements that should not hold the PR.
- **Questions for the author**: things that need clarification rather than a fix.
- **What looks good**: brief; only call out genuinely strong choices.

Follow the review tone from the thermonuclear skill: direct and demanding about quality, never rude, no softening of major maintainability issues into mild suggestions.

## Posting the Review (only when explicitly asked)

Always present the full review locally first and let the user read, trim, and adjust it. Post only after the user explicitly asks to post.

**Prefix everything posted.** Every posted body — the review summary and each inline comment — must start with the exact prefix `[🫩 Daniel's Agent]` followed by a newline, so coworkers can tell the review came from the agent. The prefix applies only to text posted to GitHub, never to the locally presented review.

1. **Summary-only review** (the common case):
   - Pick the event from the verdict: `gh pr review <number> --repo <owner/repo> --approve | --comment | --request-changes --body "<summary body>"`
   - The body should contain the verdict justification, blocking issues, and questions in a readable form; keep non-blocking suggestions brief.

2. **Inline comments + verdict** (when the user wants file/line comments on the diff):
   - Use the GraphQL `addPullRequestReview` mutation via `gh api graphql`, passing the review `event` (`COMMENT`, `APPROVE`, or `REQUEST_CHANGES`), the summary `body`, and a `comments` array of `{path, position, body}` entries with positions taken from the fetched diff.
   - Verify each `position` against the current head diff before posting; a stale position fails the whole mutation.
   - If precise positioning is uncertain for some comments, fall back to quoting the file/line inside the summary body instead of guessing positions.

3. **After posting**, report the review URL and state (approved / changes requested / commented).

Never post a pending review and leave it unsubmitted; if posting was requested, submit it.

## Boundaries

- Do not post comments or a review to GitHub unless the user explicitly asks. Default to presenting the review locally.
- Do not modify the PR's code; this skill reviews, it does not fix.
- Do not review your own branch's PR with this skill unless asked — local self-review belongs to `thermo-nuclear-code-quality-review` directly.
