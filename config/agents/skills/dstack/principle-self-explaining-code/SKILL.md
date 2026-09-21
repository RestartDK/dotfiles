---
name: principle-self-explaining-code
description: "Apply when writing or reviewing any code. No narrating comments; names, types, and structure carry intent. A comment survives only for a non-obvious why the code cannot show."
disable-model-invocation: true
---

# Self-Explaining Code

Code explains itself. Names, types, assertions, and structure carry intent; comments do not.

**Why:** Narrating comments duplicate the code and rot the moment it changes. A comment that restates the line below it trains readers to skip comments, so the one comment that matters gets skipped too. Structure is checked by the compiler; prose is checked by nobody.

**Pattern:** When tempted to write a comment, encode it instead.

- A `// Phase 1: add cards` banner becomes a well-named function.
- A `// must be non-empty` note becomes a `NonEmptyString` type or an assertion with a message: `assert(ok, 'persisted across restart')`.
- A `// careful: ms not s` warning becomes a branded type or a named constant.
- A commented-out corpse gets deleted; git remembers.
- A `do not remove` constraint comment becomes the cheapest type, test, or lint that enforces it (the **principle-encode-lessons-in-structure** skill), then gets deleted.

Keep a comment only for a non-obvious *why* the code cannot show: an external system's undocumented behavior, a spec citation, a proven-necessary workaround with its upstream issue link.

Review-time enforcement: the **no-comments** skill spawns Comment Sicko over the diff. In repos whose AGENTS.md bans comments outright (cobb), the ban wins.
