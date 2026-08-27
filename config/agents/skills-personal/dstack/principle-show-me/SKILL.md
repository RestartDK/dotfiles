---
name: principle-show-me
description: "Apply when explaining a shape, flow, state machine, or type-narrowing problem takes a third sentence. Make a diagram or runnable artifact first, prose second."
disable-model-invocation: true
---

# Show Me

When a shape, flow, or narrowing is taking a third sentence to explain, stop writing sentences. Make the diagram or artifact first.

**Why:** Prose serializes structure that is inherently parallel. A reader reconstructs the graph in their head, lossily. A diagram is the graph. For data-narrowing questions especially, the Mermaid narrowing diagram shows where untrusted input becomes a valid domain type in a way paragraphs cannot.

**Pattern:**

- State machines, lifecycles, event flows → Mermaid state or sequence diagram.
- Parse/validation boundaries → a narrowing diagram (the **parse-dont-validate** skill has the format).
- Layout, visual, or interaction questions → a small HTML artifact or a screenshot of the real thing.
- Architecture questions → a boxes-and-arrows sketch of the layers actually involved, not every layer.
- Code shape proposals → a signatures-only sketch (types and function heads, no bodies).

The **show-me** skill owns the full workflow. This principle is the trigger; fire it in replies, PR descriptions, design discussions, and teaching moments alike. The diagram is also verification: a flow you cannot draw is a flow you do not understand yet.
