---
name: thermo-nuclear-code-quality-review
description: Run an extremely strict maintainability review for abstraction quality, giant files, and spaghetti-condition growth. Use for a thermo-nuclear code quality review, thermonuclear review, deep code quality audit, or especially harsh maintainability review.
disable-model-invocation: true
---

# Thermo-Nuclear Code Quality Review

dstack wiring: run as one lens under the **interrogate** primitive when the design is contested; standalone for single-diff quality reviews.

Use this skill for an unusually strict review focused on implementation quality, maintainability, abstraction quality, and codebase health.

Above all, this skill should push the reviewer to be **ambitious** about code structure. Do not merely identify local cleanup opportunities. Actively search for "code judo" moves: restructurings that preserve behavior while making the implementation dramatically simpler, smaller, more direct, and more elegant.

## Core Prompt

Start from this baseline:

> Perform a deep code quality audit of the current branch's changes.
> Rethink how to structure / implement the changes to meaningfully improve code quality without impacting behavior.
> Work to improve abstractions, modularity, reduce Spaghetti code, improve succinctness and legibility.
> Be ambitious, if there is a clear path to improving the implementation that involves restructuring some of the codebase, go for it.
> Be extremely thorough and rigorous. Measure twice, cut once.

## Non-Negotiable Additional Standards

Apply the baseline prompt above, plus these explicit review rules:

0. **Be ambitious about structural simplification.**
   - Do not stop at "this could be a bit cleaner."
   - Look for opportunities to reframe the change so that whole branches, helpers, modes, conditionals, or layers disappear entirely.
   - Prefer the solution that makes the code feel inevitable in hindsight.
   - Assume there is often a "code judo" move available: a re-organization that uses the existing architecture more effectively and makes the change dramatically simpler and more elegant.
   - If you see a path to delete complexity rather than rearrange it, push hard for that path.

1. **Do not let a PR push a file from under 1k lines to over 1k lines without a very strong reason.**
   - Treat this as a strong code-quality smell by default.
   - Prefer extracting helpers, subcomponents, modules, or local abstractions instead of letting a file sprawl past 1000 lines.
   - If the diff crosses that threshold, explicitly ask whether the code should be decomposed first.
   - Only waive this if there is a compelling structural reason and the resulting file is still clearly organized.

2. **Do not allow random spaghetti growth in existing code.**
   - Be highly suspicious of new ad-hoc conditionals, scattered special cases, or one-off branches inserted into unrelated flows.
   - If a change adds "weird if statements in random places", treat that as a design problem, not a stylistic nit.
   - Prefer pushing the logic into a dedicated abstraction, helper, state machine, policy object, or separate module instead of tangling an existing path.
   - Call out changes that make the surrounding code harder to reason about, even if they technically work.

3. **Bias toward cleaning the design, not just accepting working code.**
   - If behavior can stay the same while the structure becomes meaningfully cleaner, push for the cleaner version.
   - Do not rubber-stamp "it works" implementations that leave the codebase messier.
   - Strongly prefer simplifications that remove moving pieces altogether over refactors that merely spread the same complexity around.

4. **Prefer direct, boring, maintainable code over hacky or magical code.**
   - Treat brittle, ad-hoc, or "magic" behavior as a code-quality problem.
   - Be skeptical of generic mechanisms that hide simple data-shape assumptions.
   - Flag thin abstractions, identity wrappers, or pass-through helpers that add indirection without buying clarity.

5. **Push hard on type and boundary cleanliness when they affect maintainability.**
   - Question unnecessary optionality, `unknown`, `any`, or cast-heavy code when a clearer type boundary could exist.
   - Prefer explicit typed models or shared contracts over loosely-shaped ad-hoc objects.
   - If a branch relies on silent fallback to paper over an unclear invariant, ask whether the boundary should be made explicit instead.

6. **Keep logic in the canonical layer and reuse existing helpers.**
   - Call out feature logic leaking into shared paths or implementation details leaking through APIs.
   - Prefer existing canonical utilities/helpers over bespoke one-offs.
   - Push code toward the right package, service, or module instead of normalizing architectural drift.

7. **Treat unnecessary sequential orchestration and non-atomic updates as design smells when the cleaner structure is obvious.**
   - If independent work is serialized for no good reason, ask whether the flow should run in parallel instead.
   - If related updates can leave state half-applied, push for a more atomic structure.
   - Do not over-index on micro-optimizations, but do flag avoidable orchestration complexity that makes the implementation more brittle.

8. **Preserve error taxonomy.**
   - Do not collapse distinct failure causes (missing, expired, already consumed, unauthorized, malformed) into one opaque error; callers and support must be able to tell them apart.
   - Use cause-specific messages and the idiomatic status for each case (`NotFound` for missing, not a generic `FailedPrecondition`).

9. **No silent behavior changes.**
   - Changing a default, a flag's meaning, a hash's semantics, or a fallback's behavior without making it explicit is a blocker; rename the knob or document the new semantics.
   - If the PR description or ticket claims a behavior, the code must actually implement it and the tests must prove it.

10. **Tests must exercise the new path.**
    - Fixture-only updates (adding `None` / defaults to every existing fixture) prove nothing about the new variant; require at least one test driving the `Some` / new-variant path end to end.
    - Assert payload-level properties, not just discriminators or tags.

11. **Verify reachability and ordering of validation.**
    - Check that new error branches are actually reachable; a stricter upstream check can make a downstream branch dead (e.g. a strict parse inside an access check making a later loose parse infallible).
    - Validation belongs in the right order: parse/validate at ingress, then authorization, then business rules.

12. **Question hardcoded assumptions.**
    - Hardcoded locales, regions, currencies, domains, or environment-specific constants must be confirmed as intentional, not assumed.
    - A one-line "intentional?" question is appropriate when the diff silently narrows who or what the code works for.

## Language-Specific Standards

Apply these on top of the general standards whenever the diff touches Rust or frontend code. They are not stylistic nits; violations are presumptive blockers on the same footing as the general standards.

### Rust

1. **No free functions.**
   - Prefer inherent `impl` blocks or trait implementations so behavior lives on the type it operates on.
   - If a new free function only manipulates one type's data, ask why it is not a method on that type.
   - Accept free functions only where there is no natural owner type (e.g. genuine module-level orchestration).

2. **Prioritize Rust standard traits.**
   - Prefer `TryFrom`, `FromStr`, `Display`, `Deref`, `From`, `Iterator`, etc. over ad-hoc `to_*` / `parse_*` / `as_*` functions.
   - Flag bespoke conversion or parsing functions that duplicate what a standard trait impl would express canonically.

3. **No `unwrap` or deferred error handling.**
   - Flag `unwrap`, `expect`, `.ok()`, `let _ = ...`, `unwrap_or(...)`, and `_ => {}` arms that silently discard errors.
   - Errors must be handled immediately at the site where they occur: propagate with `?`, or handle explicitly with logging and a typed error return.
   - Logic that defers or papers over error handling is a correctness problem, not a style preference.

4. **Exhaustive matching over ad-hoc conditionals.**
   - Prefer `match` that handles every variant explicitly over `if let` / early-return chains that ignore cases.
   - New enum variants must force compile errors at every site that needs to handle them; wildcard arms that swallow future variants hide bugs.

5. **Semantic IDs everywhere.**
   - IDs must use the domain-specific newtype (e.g. `AgentId`, `TaskId`) end to end: models, service methods, events, commands, storage, protobuf, and generated frontend types.
   - Flag raw `String` / `Uuid` parameters or fields where the identity domain is known, and any partially typed path that silently downgrades to raw IDs at some layer.

6. **Total functions over `Option` smuggling.**
   - When half the variants of a flat enum cannot produce a value, narrow once at the boundary into a narrower type and make operations total on it, instead of returning `Option` and repeating the same partition at every consumer.
   - Prefer real ADTs (tagged enums with payloads) over flat enum + `Option` fields + runtime invariants. Mirror DB `CHECK` constraints in the type system (`NonZero`, validated newtypes) so invalid states are unrepresentable rather than merely rejected at runtime.

7. **No silent drops in iterator pipelines.**
   - `?` inside `filter_map`, or `filter`/`map` combinations that silently skip elements on error or lookup miss, are blockers: they turn failures into missing output with no signal.
   - Collect into `Result<Vec<_>>` or handle the failure explicitly.

8. **Parse and validate at the ingress boundary.**
   - JSON deserialization, string-to-enum parsing, and ID parsing belong at the gRPC/HTTP/CLI boundary, before business logic and before any transaction opens.
   - A malformed payload must be rejected before any write happens, not fail a transaction mid-flight with a generic error. Domain concepts (sectors, plans, tiers) must be real enums, not bare `String`s whose valid values live in another module.

9. **Protobuf and transport hygiene.**
   - No untyped JSON or metadata fields in the transport protocol; every field must be properly typed. If business logic starts depending on a legacy untyped field's contents, the fix is an additive typed field, not more parsing downstream.
   - Changes must be additive and wire-compatible; removed fields get `reserved` for both number and name, never `[deprecated = true]`.
   - UUID-backed string fields must use typed-string codegen with their semantic ID annotation.

10. **Scoped and documented `#[allow]`.**
    - `#[allow(deprecated)]`, `#[allow(clippy::...)]`, and similar must sit on the smallest possible scope with an adjacent one-line justification of what is being accepted and why.
    - Cargo-culted allows without a stated reason hide real drift.

11. **Bounded migrations.**
    - Backfill `UPDATE`s must be bounded (for example `EXISTS` guards that skip no-op rows) so they do not rewrite the whole table and inflate the WAL while holding the writer lock.
    - New user-facing queries must state their `LIMIT`; new tables must come with their growth model and indexes justified.

### Frontend / TypeScript

1. **Types come from Rust codegen, period.**
   - Types must flow from Rust through WASM/TS codegen so the frontend is fully typed end to end.
   - If a needed type is missing from the generated TS declarations, the fix is to add/type it on the Rust side and regenerate — never to hand-write a parallel TS interface or cast around the gap.
   - Flag any hand-maintained frontend type that duplicates a backend shape, and any `as` cast or brand manufactured by assertion instead of real parsing at the ingress boundary.

2. **Use the design system, not raw HTML.**
   - Always use existing atoms, molecules, and organisms from the repo's component library. Raw tags like `<button>`, `<input>`, or `<select>` in feature code are a blocker.
   - If the needed component does not exist, the fix is to extend the design system, not to inline a one-off.

3. **No `useEffect` except explicitly justified cases.**
   - Data fetching must go through React Query (or the repo's canonical data layer), never `useEffect` + fetch.
   - Treat any new `useEffect` as presumptively wrong; require an explicit justification for why no declarative alternative applies.

4. **Design system tokens in CSS.**
   - Styling must use existing design system tokens (colors, spacing, typography, radii). Flag hardcoded hex values, pixel paddings, or font sizes that bypass the token system.
   - If a token is missing, extend the token set rather than hardcoding.

5. **No duplicated inline logic that can drift.**
   - The same fallback chain, formatter, regex, or badge-variant mapping inlined in several components (each slightly different) must be extracted into one shared hook or helper so the copies cannot drift further.
   - If an existing hook already does the job (caching, error fallback, unmount handling included), use it instead of reimplementing it with local state.

6. **Loading and error states.**
   - Localized skeletons on the data that is loading; keep chrome (toolbars, tabs, tables) mounted. No whole-card or whole-tab placeholder swaps.
   - A failed query must render a distinct error state with a path to retry; "loading forever" on error is a blocker.
   - Data that changes without user action (live runs, in-progress work) needs an explicit refresh strategy (`refetchInterval` gated on non-terminal state, or targeted invalidation), not a frozen first fetch.

7. **Keyboard and screen-reader accessibility.**
   - Interactive elements must be real focusable controls from the design system, never `div onClick` or `span onClick`; selection, sorting, and expansion must work with Enter/Space.
   - Information conveyed only via hover tooltips must also be reachable by keyboard and announced via labels.

8. **React correctness habits.**
   - State updater functions must be pure: no side effects (including other `setState` calls) inside updaters; StrictMode double-invokes them.
   - Measure containers with `ResizeObserver`, not mount-time measurement plus `window` resize; sibling panels opening/resizing change container width too.
   - Pointer-capture drags must handle `pointercancel`, not just `pointerup`.

9. **No unbounded operations over unbounded collections.**
   - Flag spreading large arrays into variadic calls (`Math.max(...items)` throws `RangeError` past engine argument limits), rendering thousands of rows without virtualization, and per-scroll-event state updates that re-render entire lists.
   - Prefer `reduce`, memoized row lists, and ref-based values for high-frequency events like scroll offsets.

## Primary Review Questions

For every meaningful change, ask:

- Is there a "code judo" move that would make this dramatically simpler?
- Can this change be reframed so fewer concepts, branches, or helper layers are needed?
- Does this improve or worsen the local architecture?
- Did the diff add branching complexity where a better abstraction should exist?
- Did a previously cohesive module become more coupled, more stateful, or harder to scan?
- Is this logic living in the right file and layer?
- Did this change enlarge a file or component past a healthy size boundary?
- Are there repeated conditionals that signal a missing model or missing helper?
- Is the implementation direct and legible, or does it rely on special cases and incidental control flow?
- Is this abstraction actually earning its keep, or is it just a wrapper?
- Did the diff introduce casts, optionality, or ad-hoc object shapes that obscure the real invariant?
- Is this logic living in the canonical layer, or did the diff leak details across a boundary?
- Is this orchestration more sequential or less atomic than it needs to be?

## What to Flag Aggressively

Escalate findings when you see:

- A complicated implementation where a cleaner reframing could delete whole categories of complexity.
- Refactors that move code around but fail to reduce the number of concepts a reader must hold in their head.
- A file crossing 1000 lines due to the PR, especially if the new code could be split out.
- New conditionals bolted onto unrelated code paths.
- One-off booleans, nullable modes, or flags that complicate existing control flow.
- Feature-specific logic leaking into general-purpose modules.
- Generic "magic" handling that hides simple structure and makes the code harder to reason about.
- Thin wrappers or identity abstractions that add indirection without simplifying anything.
- Unnecessary casts, `any`, `unknown`, or optional params that muddy the real contract.
- Copy-pasted logic instead of extracted helpers.
- Narrow edge-case handling implemented in the middle of an already busy function.
- Refactors that technically pass tests but make the code less modular or less readable.
- "Temporary" branching that is likely to become permanent debt.
- Bespoke helpers where the codebase already has a canonical utility for the job.
- Logic added in the wrong layer/package when it should live somewhere more central.
- Sequential async flow where obviously independent work could stay simpler and clearer with parallel execution.
- Partial-update logic that leaves state less atomic than necessary.

## Preferred Remedies

When you identify a code-quality problem, prefer suggestions like:

- Delete a whole layer of indirection rather than polishing it.
- Reframe the state model so conditionals disappear instead of getting centralized.
- Change the ownership boundary so the feature becomes a natural extension of an existing abstraction.
- Turn special-case logic into a simpler default flow with fewer exceptions.
- Extract a helper or pure function.
- Split a large file into smaller focused modules.
- Move feature-specific logic behind a dedicated abstraction.
- Replace condition chains with a typed model or explicit dispatcher.
- Separate orchestration from business logic.
- Collapse duplicate branches into a single clearer flow.
- Delete wrappers that do not meaningfully clarify the API.
- Reuse the existing canonical helper instead of introducing a near-duplicate.
- Make type boundaries more explicit so the control flow gets simpler.
- Move the logic to the package/module/layer that already owns the concept.
- Parallelize independent work when that also simplifies the orchestration.
- Restructure related updates into a more atomic flow when partial state would be harder to reason about.

Do not be satisfied with "maybe rename this" feedback when the real issue is structural.
Do not be satisfied with a merely cleaner version of the same messy idea if there is a plausible path to a much simpler idea.

## Review Tone

Be direct, serious, and demanding about quality.
Do not be rude, but do not soften major maintainability issues into mild suggestions.
If the code is making the codebase messier, say so clearly.
If the implementation missed an opportunity for a dramatic simplification, say that clearly too.

Good phrases:

- `this pushes the file past 1k lines. can we decompose this first?`
- `this adds another special-case branch into an already busy flow. can we move this behind its own abstraction?`
- `this works, but it makes the surrounding code more spaghetti. let's keep the behavior and restructure the implementation.`
- `this feels like feature logic leaking into a shared path. can we isolate it?`
- `this abstraction seems unnecessary. can we just keep the direct flow?`
- `why does this need a cast / optional here? can we make the boundary more explicit instead?`
- `this looks like a bespoke helper for something we already have elsewhere. can we reuse the canonical one?`
- `i think there's a code-judo move here that makes this much simpler. can we reframe this so these branches disappear?`
- `this refactor moves complexity around, but doesn't really delete it. is there a way to make the model itself simpler?`

## Output Expectations

Prioritize findings in this order:

1. Structural code-quality regressions
2. Missed opportunities for dramatic simplification / code-judo restructuring
3. Spaghetti / branching complexity increases
4. Boundary / abstraction / type-contract problems that make the code harder to reason about
5. File-size and decomposition concerns
6. Modularity and abstraction issues
7. Legibility and maintainability concerns

Do not flood the review with low-value nits if there are larger structural issues.
Prefer a smaller number of high-conviction comments over a long list of cosmetic notes.

## Approval Bar

Do not approve merely because behavior seems correct.
The bar for approval is:

- no clear structural regression
- no obvious missed opportunity to make the implementation dramatically simpler when such a path is visible
- no unjustified file-size explosion
- no obvious spaghetti-growth from special-case branching
- no obviously hacky or magical abstraction that makes the code harder to reason about
- no unnecessary wrapper/cast/optionality churn obscuring the real design
- no clear architecture-boundary leak or avoidable canonical-helper duplication
- no missed opportunity for an obvious decomposition that would materially improve maintainability

Treat these as presumptive blockers unless the author can justify them clearly:

- the PR preserves a lot of incidental complexity when there is a plausible code-judo move that would delete it
- the PR pushes a file from below 1000 lines to above 1000 lines
- the PR adds ad-hoc branching that makes an existing flow more tangled
- the PR solves a local problem by scattering feature checks across shared code
- the PR adds an unnecessary abstraction, wrapper, or cast-heavy contract that makes the design more indirect
- the PR duplicates an existing helper or puts logic in the wrong layer when there is a clear canonical home

If those conditions are not met, leave explicit, actionable feedback and push for a cleaner decomposition.
