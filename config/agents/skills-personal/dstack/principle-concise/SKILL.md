---
name: principle-concise
description: "Apply to any prose you produce: replies, PR descriptions, commit messages, docs, agent-facing instructions. Short declarative sentences, no filler, no bloat; every sentence earns its place by changing a decision."
disable-model-invocation: true
---

# Concise

Write short declarative prose everywhere. One thought per sentence. No filler, no hedging, no restating what the reader can see.

**Why:** Bloated prose hides the load-bearing sentence. In PRs, it costs reviewer time. In agent-facing text, unhelpful sentences become instructions. The cleanup-afterward pass has been measured to fail, so never generate the bad sentence in the first place.

**Pattern:** Before writing a sentence, ask what decision it changes for the reader. No decision, no sentence.

- Prefer one word for each action. Keep articles. Avoid `-ing` when a plain verb works.
- Delete throat-clearing ("It's worth noting that", "In order to", "Basically").
- A list of three beats a paragraph of three clauses.
- Terse is not an excuse to drop content. Tradeoffs, choices, and open decisions stay; padding goes.
- PR titles are conventional-commit form, subject short and imperative, naming a real symbol when one carries the change.

This principle is generation-time. The **unslop** skill is its review-time counterpart for text that already exists.
