# dstack guide

This file teaches you, not the agent. The agent reads `dstack-mode/SKILL.md`.

## The one thing to remember

Give the agent a goal and a way to check it, in your own words. You do not need to name a playbook; the mode matches it. "Fix the flaky digest test, prove it with 20 green runs" beats a step list every time.

## Daily flows

- **Morning demo.** `/dstack get the app demoable with the store fixture` → stack-up → login URL + screenshot proof.
- **Bug report.** `/dstack repro this run: <url>` → repro → bug-fix. The failing test lands before the fix so the diff tells the story.
- **Feature.** `/dstack add X; acceptance: Y` → how → architect → delegated implementation → verified on the real surface.
- **PR watching.** `/dstack babysit PR 123` (drive) or `/dstack check on PR 123` (one pass). Landing a green stack is `ship the stack`, a different playbook with its own gates.
- **Cleanup.** `/dstack refactor Z, behavior identical` → the pin comes first; no pin, no refactor.
- **Design fork.** Don't answer "which approach?" yourself if a run can answer it: say `prototype both and show me`.

## Steering vocabulary

Catch the agent doing X → say Y. One phrase redirects better than a paragraph because the name points at a rule it already read.

- Declaring done after `cargo check` → "prove it works".
- Adding a layer/abstraction/flag → "laziness protocol" or "subtract before you add".
- Long explanation of a flow → "show me".
- Guessing at a bug → "fix root causes; repro first".
- Big diff in one commit → "sequence verifiable units".
- Inventing a new button style → "design system first".
- Narrating comments → "self-explaining code".
- Scary boundary change → "blast radius".
- Reading a 3000-line file into context → "guard the context window".
- Asking you a question a run could answer → "never block on the human; prototype it".
- Same instruction twice → "encode lessons in structure".

Audit rule: every cited principle must name the decision it changed. A bare citation means it name-dropped; call it.

## Subagent roles

- kimi-k3 (fireworks): fast mechanical edits, swarm workers.
- gpt-5.6-sol: precisely-specified implementation.
- claude-sonnet-4-5: judgment, prose, review, cross-judging.
Change them in `models.md`. Fan-out list lengths set panel sizes (arena runners, interrogate reviewers).

## Recipes and pitfalls

Add a line here after every session that surprised you. This page appreciates.

- `stack-up.sh --reset` is the fix for `migration was previously applied but has been modified`. Never work around it with a new migration.
- Babysit works the merge frontier only. If the agent is fixing an upstack thread while the bottom PR is red, stop it.
- Shipping: verdicts go stale on restack. The patch-id check is not optional.
- Eval anything reflect proposes before promoting it. Blind, sanitized dirs, judge scores from files-actually-read.
- One writer per worktree. Parallel workers on the same branch is how work vanishes.
