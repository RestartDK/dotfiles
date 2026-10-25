---
name: principle-guard-the-context-window
description: "Apply when context is filling up: large outputs, long files, repeated reads, fan-out planning. Route bulk to subagents; keep summaries in the main thread, not raw payloads."
disable-model-invocation: true
---

# Guard the Context Window

The context budget is finite for each model request. Compaction reclaims input space by summarizing older history. Every token that enters should earn its place.

**Why:** Large payloads increase context cost and obscure details needed for the next step. Compaction can omit details, so preserve important progress and evidence in the existing task record.

**Pattern:**
- **Continue after compaction.** Context pressure and compaction are not reasons to pause or hand off. Let Pi compact, then continue the authorized task.
- **Isolate large payloads.** Route verbose outputs, screenshots, and large documents to subagents. The main context gets summaries, not raw data.
- **Don't read what you won't use.** Read selectively based on relevance. If a file isn't needed for the current task, skip it.
- **Keep frequently used content inline.** Templates and references used on every invocation belong in the skill file, not in separate files that cost a read each time.
- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.
