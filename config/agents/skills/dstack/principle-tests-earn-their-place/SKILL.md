---
name: principle-tests-earn-their-place
description: "Apply when adding, keeping, or deleting tests and before review. Weigh regression protection, refactoring resistance, feedback, and maintenance cost. Overlap alone is not a reason to delete a test. Explain surviving coverage and lost value before removal."
disable-model-invocation: true
---

# Tests Earn Their Place

A test earns its place through meaningful regression protection, useful feedback, and confidence when changing code. Weigh those benefits against maintenance, execution, and diagnostic costs. Test count, coverage percentage, and overlapping coverage do not decide its value alone.

Tests can pass without useful assertions or fail after harmless refactors. A short or repetitive test can still protect money, authentication, replay compatibility, or a public contract. Judge what the test establishes, not its name, length, or shape.

The rule is language-neutral. It applies to a Rust unit test, a vitest component test, a Playwright flow, and a SQL fixture alike.

## Ask six questions

- **What contract or failure matters here?** Name the incorrect behavior the test protects against. Establish requirements, not the current implementation's sequence of steps.
- **Would a meaningful bug make it fail?** Inspect the assertions. When uncertain, deliberately break the claimed behavior. Executing the relevant code is not sufficient. Harmless or equivalent mutations need not fail.
- **Would a correct refactor leave it green?** Avoid private layout, incidental call order, copied prose, and arbitrary counts. Keep checks where exact representations, ordering, or counts are themselves contractual.
- **What does it add to the remaining suite?** Value can be a different failure mode, a real integration boundary, faster feedback, or clearer diagnosis. A focused unit test and an adapter test can both earn their place. Overlap alone is not grounds for deletion.
- **Is its ongoing cost justified?** Consider readability, setup, runtime, flakiness, infrastructure, and time to diagnose failures. Simplify an important guard before discarding it.
- **Is this the appropriate test boundary?** Use focused tests for isolated logic and broader tests for risks that require components to interact. Do not impose a universal unit-to-integration ratio or coverage threshold. Use coverage to find possible gaps, not to prove assertion quality.

## Choose the action

| Action | Rule |
| --- | --- |
| Keep | Meaningful protection or feedback justifies the cost. |
| Rewrite or consolidate | The behavior matters, but the test proves it poorly or expensively. Preserve useful cases and assertions when merging tests. |
| Remove | The behavior is obsolete, the assertion only mirrors implementation, or the test adds no worthwhile protection or feedback. Explain why before removal. |

## Examples of valuable protection

These are examples, not an exhaustive whitelist. Apply the questions above to algorithms and business rules too.

- Boundary parsers accept valid input and reject malformed or forbidden input.
- Stored-data compatibility preserves old rows, legacy defaults, and snapshot behavior for data that still exists.
- External contracts expose the intended schema and actions. Machine-readable examples parse as valid input.
- Money calculations exercise the real lookup, conversion, rounding, and idempotency behavior, not copied constants.
- Security tests exercise rejection, revocation, private-field exclusion, and the security primitive's actual behavior.
- State-machine tests distinguish valid transitions from wrong identities, races, and out-of-order events.
- Provider contracts check headers, auth variables, and payload shapes. Use a table when it preserves distinct cases and useful failure messages.
- UI tests exercise user-visible state, interaction, error recovery, and accessibility semantics such as `role`, `checked`, `disabled`, and `aria-*`.

## Usually rewrite or remove

These are warning signs, not automatic deletion rules.

- Incidental count pins, such as the current number of icons. A resource, retry, billing, or model-schema budget can justify a count assertion.
- Copied prompt prose or literal markup with no external contract. Required public text and machine-readable examples can be contracts.
- Getter or setter checks that only restate a literal fixture.
- Generated serialization round-trips with no custom behavior or stored-data compatibility case.
- Render-only checks with no meaningful state, interaction, or accessibility assertion.
- Tests that reimplement business logic or query a different path than the production handler.
- Repeated assertions at several layers with no added protection, confidence, speed, or diagnosis.
- Mocks that replace the behavior the test claims to exercise.
- Single-sample claims about nondeterministic behavior, especially when retries hide failures.

## Execution policy for nondeterministic dependencies

These restrictions apply independently of a test's value.

**Paid and live-harness calls are out of bounds.** A test may not spend money, need credentials, or spawn a real agent CLI, including behind an env-var hatch that points the suite at an installed binary or provider. When only a live model can check a behavior, check it once by hand, put the exact command and the observed result in the PR, and keep it out of the suite. The tempting case is the one to refuse. "The model should have chosen tool X" is an observation to record by hand, never a test to run in CI.

Where the dependency is faked rather than called, a test earns its place only in the leg the fake cannot cover. Seed fixtures deterministically. Decode the result into a typed value and compare it to a typed expectation; never grep prose. Assert the artifact's provenance and shape, not the route taken to it. Pin the model to a production alias, not a hardcoded SKU string. No in-test retry loops, no cache-busting nonces. A terminal "finished successfully" event is not an assertion.

## Explain each deletion

Review deletions per test, not per line count. For each deletion:

- Name the behavior and assertions being removed.
- Name surviving coverage by file and test name, or explain why no replacement is needed. Inspect the survivor's actual assertions and test boundary.
- Explain lost value, including failure cases, integration confidence, feedback speed, and diagnosis. "Another test covers it" is not sufficient.
- Transfer useful cases before consolidation. Preserve a timeout, negative case, ownership check, or compatibility assertion that the survivor does not yet contain.

If a required behavior loses meaningful protection, keep or rewrite its guard. Obsolete behavior and assertions that never established a contract need no replacement. Explain the retirement or the lack of value. Do not invent a CI-cost argument without measurements.

A deletion PR carries a description. Keep production behavior changes separate from test-only cleanup.

## The pre-review pass

Walk the test diff once. Each added test names its contract and contribution to the suite. Each deletion accounts for surviving coverage and lost value. Apply the six questions to rewrites and fixture changes too.

Fixture-only updates do not prove a new variant. Drive the new path and assert its meaningful outcome. A successful command proves only what its selected tests actually exercised.

## Sources

- Kent Beck, [Test Desiderata](https://github.com/KentBeck/TestDesiderata/blob/master/index.md). Behavioral, structure-insensitive, deterministic, fast, readable, and specific tests involve tradeoffs.
- Google Testing Blog, [Change-Detector Tests Considered Harmful](https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html). Tests that mirror implementation can obstruct safe changes.
- Vladimir Khorikov, [False positives and flaky tests](https://khorikov.org/posts/2020-02-11-false-positives-flaky-tests/). Balance regression protection, refactoring resistance, fast feedback, and maintainability.
- Martin Fowler, [Test Coverage](https://www.martinfowler.com/bliki/TestCoverage.html) and [Mutation Testing](https://martinfowler.com/bliki/MutationTesting.html). Execution coverage and meaningful fault detection answer different questions.
- Martin Fowler, [Test Pyramid](https://www.martinfowler.com/bliki/TestPyramid.html), and Kent C. Dodds, [Write tests. Not too many. Mostly integration.](https://kentcdodds.com/blog/write-tests). They favor different test mixes. Neither establishes a universal ratio for every system.
