---
name: get-pr-comments
description: Fetch and summarize review comments from the active pull request.
---

# Get PR comments

## Trigger

Need a concise, actionable summary of feedback on the active pull request.

## Workflow

1. Resolve the active PR for the current branch:
   - Prefer `gh pr view --json number,title,url,headRefName,baseRefName,reviewDecision`.
   - If no PR is found for the current branch, stop and report that there is no active PR.
2. Fetch all feedback sources:
   - PR metadata and reviews: `gh pr view --json number,title,url,comments,reviews,latestReviews,reviewDecision,statusCheckRollup`
   - Issue/PR discussion comments: `gh api repos/:owner/:repo/issues/<number>/comments --paginate`
   - Inline review comments: `gh api repos/:owner/:repo/pulls/<number>/comments --paginate`
   - Review summaries: `gh api repos/:owner/:repo/pulls/<number>/reviews --paginate`
3. Deduplicate comments by id/url and ignore outdated duplicates when a newer review thread clearly supersedes them.
4. Group feedback by severity and actionability:
   - Blocking correctness/security/data-loss issues
   - Required changes requested by reviewers
   - Test or validation gaps
   - Maintainability/readability suggestions
   - Non-actionable praise, status updates, or resolved discussion
5. For each actionable item, include reviewer, file/line when available, comment URL when available, and the concrete requested change.
6. Do not make code changes while gathering comments unless explicitly asked after the summary.

## Output

- PR number, title, and URL
- Grouped feedback summary
- Action list ordered by priority
- Open questions that still need clarification
