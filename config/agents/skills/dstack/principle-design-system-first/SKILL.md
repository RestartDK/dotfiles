---
name: principle-design-system-first
description: "Apply to any UI work. Start from the app's existing design system, tokens, and primitives; a new primitive needs justification. Sweat transitions, alignment, and error states; every feature earns its place."
disable-model-invocation: true
---

# Design System First

UI work starts from the app's existing design system. Reuse its tokens, spacing, primitives, and patterns before inventing anything.

**Why:** A one-off component forks the visual language and doubles future maintenance. Users experience inconsistency as poor quality even when each screen looks fine in isolation. The existing system encodes decisions (contrast, density, states) that a fresh primitive silently re-litigates.

**Pattern:** Before building UI, inventory what exists.

1. Find the design system: component library, tokens file, theme, closest existing screen doing something similar.
2. Compose from existing primitives. Match spacing scale, typography, color roles, radius, and interaction states exactly.
3. A new primitive needs justification: name the gap in the system it fills and why no composition covers it. Propose it as a system addition, not a screen-local one-off.
4. Loading states are localized skeletons on the exact data that is loading, keeping real structure and chrome mounted, never replacement placeholder cards.
5. Sweat the details: transitions, alignment, empty states, error states, focus order. Ship three polished features over ten rough ones; every feature earns its place. "User" includes the colleague importing your library and the next engineer maintaining the code.

Verify on the real surface: a screenshot of the rendered result against neighboring screens, not a code read.
