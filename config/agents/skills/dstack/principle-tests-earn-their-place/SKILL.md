---
name: principle-tests-earn-their-place
description: "Apply when adding, keeping, or deleting a test, when reviewing a PR's test diff, and in the pre-review pass. A test stays only if deleting it would let a production break through that nothing else catches first. Cut pins, round-trips, and prose greps; a deleted guard names its surviving equivalent."
disable-model-invocation: true
---

# Tests Earn Their Place

A test is worth its CI seconds when its deletion would let a specific production break reach users, and no other check (type system, lint, another test, a runtime guard) catches that break first. Every other test is weight. Ask the question in both directions: before writing a test, and before deleting one.

**Why:** Suites grow by accretion. Each test looked reasonable when written, and nobody ever deletes. The result is a suite where 80% of the cases pin literals or round-trip derived code, and CI time becomes a target. When someone finally cuts, they cut by shape (short tests, many similar names), and the real guards hidden among the noise go with them. One audit of 2,200 deletions found roughly 80% were correctly cut and about 150 to 200 real guards on money, auth, replay compatibility, and security primitives left with no surviving equivalent, because the deletion PRs judged by name and line count.

**Failure mode this prevents:** a constant-time compare used by the CSRF check with an empty test module; a pricing lookup whose tests assert the constant instead of the lookup; a model-facing tool schema that regains a `read` action because the only test that pinned its two actions was a "one-liner"; 17 API providers with no header-shape contract because the per-provider tests looked repetitive; a settings radio whose `checked` state and a preparing screen whose error-with-retry path lost their only tests because they were short.

The rule is language-neutral. It applies to a Rust unit test, a vitest component test, a Playwright flow, and a SQL fixture alike.

## The worth question

For any test, name the production break it catches in one sentence. If the sentence needs the words "the constant changed" or "the derive macro broke", the test has no place. If the break is already caught by a type, a lint, or a test that already exists, the test has no place. If the sentence names a real failure and nothing else catches it, the test stays, whatever its length.

## Write these

Deterministic, cheap, and nothing upstream of production catches the regression.

1. **Boundary parsers with the negative case.** Webhook and payment-provider payload decode, timezone and cron rejection, ingress parsers for route params and labelled strings. The hand-written branch, never the derived round-trip.
2. **Backward compatibility of stored data.** Old-format rows deserialize, removed fields are ignored, unspecified enum values resolve to the legacy behavior, snapshot defaults hold. One test per compatibility decision, kept as long as the data exists.
3. **External contracts as schema assertions.** What a model, a partner API, or a public endpoint sees: hidden legacy fields stay hidden, enums are complete, required lists are present, the example embedded in a description parses as valid input, a tool exposes exactly its intended actions.
4. **Money through the real function.** The lookup by key, not the constant. Currency mapping, experiment bucket edges, provider payload decode, unit conversion, idempotency references.
5. **Security negatives.** Constant-time compare, insecure-flag rejection, public serialization omitting private fields, revocation mapping, SSRF hostname rejection. One line of regression from each is an incident.
6. **State-machine races and rejections.** The wrong-id-dropped case, out-of-order resolution, the transition that must not happen. The happy path alone proves nothing about the guard.
7. **Provider or plugin contracts as one table.** Headers, auth variables, placeholder backing per provider, in one table-driven test. Never 87 one-liners, never zero.
8. **User-visible state and accessibility transitions.** Loading, empty, error-with-retry, disabled-while-pending, and the state assistive technology reads (`role`, `checked`, `disabled`, `aria-*`). The callback fires from the rendered control, the error state exposes the retry, the empty state offers exactly its one action. Not that the component rendered.

## Cut these, and do not write them

- Count pins (`tools.len() == 31`, `icons.len() == 291`).
- `prompt.contains("<sentence copied from the prompt>")` and other literal-copied-from-source assertions.
- Set a field, assert the getter. Build a struct or object literal, assert its own fields.
- Round-trips of generated or derived serialization with no hand-written branch.
- Renders without crashing, className presence, svg attribute checks, snapshots of literal markup, label text copied from the component.
- Tests that reimplement the logic inline, or run their own SQL instead of calling the handler under test.
- The same behavior asserted at three layers (unit, component or integration, end-to-end) with nothing added per layer.
- A mock so complete the test exercises the mock.
- Single-sample negatives against a nondeterministic system ("the model never called X") that a retry policy hides.

## Nondeterministic dependencies (models, third-party endpoints)

A test that calls a model or a remote service earns its place only in the leg it cannot fake. Seed fixtures deterministically. Decode the result into a typed value and compare it to a typed expectation; never grep prose. Assert the artifact's provenance and shape, not the route taken to it. Pin the model to a production alias, not a hardcoded SKU string. Live in the one test package that owns retries and a long timeout. No in-test retry loops, no cache-busting nonces. A terminal "finished successfully" event is not an assertion.

## Deleting tests

A test-deletion diff is reviewed per test, not per line count. For each deleted test the PR names the surviving equivalent (file and test name) or marks it LOST with the reason it never guarded anything. A LOST guard in classes 1 through 8 above is restored or rewritten as a table, not deleted. A deletion PR carries a description; a PR titled `perf` or `chore` never changes production behavior alongside.

## The pre-review pass

Before review, walk the test diff once. Each added test answers the worth question in one sentence. Each deleted test names its survivor or its LOST reason. Fixture-only updates (adding a default to every existing fixture) do not count as coverage of the new variant; at least one test drives the new path.
