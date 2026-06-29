---
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarizing the current conversation so a fresh agent can continue the work. Save the document to the temporary directory of the user's OS, not the current workspace.

Next-session focus provided by the user, if any:

$ARGUMENTS

If the user passed arguments after `/handoff`, treat those arguments as the description of what the next session will focus on and tailor the handoff document accordingly.

## Output location

- Save a Markdown file in the OS temp directory.
- Prefer discovering the temp directory with a standard OS mechanism, for example Python's `tempfile.gettempdir()` or `${TMPDIR:-/tmp}` on Unix-like systems.
- Use a clear filename such as `handoff-YYYYMMDD-HHMMSS.md`.
- After writing the file, report only the file path and a brief summary of what it covers.

## Required content

Include these sections when applicable:

1. `# Handoff`
2. `## Next-session focus`
3. `## Current objective`
4. `## Context and decisions`
5. `## Completed work`
6. `## Current working state`
7. `## Validation ledger`
8. `## Blockers and risks`
9. `## Exact next steps`
10. `## Suggested skills`
11. `## References`

## Suggested skills section

In `## Suggested skills`, recommend any skills the next agent should invoke, with a one-line reason for each. If no specialized skills are relevant, say so explicitly.

## Content rules

- Do not duplicate content already captured in other artifacts such as PRDs, plans, ADRs, issues, commits, diffs, or generated files. Reference those artifacts by path, URL, branch, commit, or command instead.
- Include enough context for a fresh agent to proceed without reading this conversation, but keep it concise.
- Clearly state the repository path, branch, active task/issue, changed files, validation commands and results, unresolved failures, and the exact next action.
- Redact sensitive information, including API keys, passwords, tokens, cleartext secrets, private keys, credentials, and unnecessary personally identifiable information.
- Do not include raw secrets from environment variables, config files, logs, command output, or session transcripts.
- Prefer references to large files or diffs over pasted content.
