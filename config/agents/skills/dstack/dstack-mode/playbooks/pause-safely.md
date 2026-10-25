### Pause safely

**You own a clean stop. Leave a checkpoint a cold-start agent can resume from.** Use only on an explicit user request to pause, go offline, restart Pi, or hand work over. Context pressure and compaction are not pause requests. On "keep going", "going to bed, keep going", or "don't stop", do not pause. Continue the current task and update its progress record.

1. Stop at a safe boundary. Finish the current atomic step or back out of it. Never stop mid-edit in a known-broken state. Start nothing new, and cancel any nested subagents.
2. Don't cross an irreversible line to pause. No PR and no push unless you already had one out.
3. Make the work durable. Commit uncommitted edits as one clear `wip:` commit on the current branch so nothing is lost. If the tree is broken, say so in the commit body in one line.
4. Write the resume note off-context. Capture intent, what you were doing, progress and what's verified, current state, next steps, key files, and gotchas. If a show-me-your-work trail exists, point at it instead of duplicating it.

**Reply:** where you are in the loop, what's on disk versus still in your head (paths, no diff dumps), the commits you made and whether the tree is clean, and the first action on resume. This is a pause, not a final report. Resume is the Session pickup playbook reading this note.
