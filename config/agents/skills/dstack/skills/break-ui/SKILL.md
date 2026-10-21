---
name: break-ui
description: Stress-test changed UI with realistic worst-case data, empty and large collections, loading and error states, and narrow layouts. Use before final verification of UI changes or when asked to find visual edge cases. Does not redesign the UI or replace acceptance tests.
license: MIT
---

# Break UI

Adapted from [Emil Kowalski's break-ui](https://github.com/emilkowalski/skills/tree/main/skills/break-ui). The upstream copyright and license are in `LICENSE`. `CATALOG.md` keeps the upstream realistic-value catalog.

## Scope and authorization

Start with the named component or the UI changed by the active task. Do not wait for a second prompt or announce readiness. Read the repository's UI, browser, fixture, and test instructions first. Reuse the running task-owned browser and server; never restart the user's stack.

An audit reports findings without fixes. During an authorized implementation, fix clear defects within that scope. Ask only for genuine product choices, such as whether primary identifying text should wrap or truncate. This skill grants no commit, publication, deployment, or production-data permission.

## Map the rendered data

List each rendered field, its source, type, optionality, and accepted limit. Include names, identifiers, numbers, statuses, labels, dates, images, and collection length. Read the actual form and API contracts. If no limit exists, record "unbounded"; do not invent a limit or alter the backend to make the test easier.

Read `CATALOG.md`. Choose plausible synthetic values or the actual accepted boundary. Invalid values belong in rejection/error tests, not in supposedly valid typed fixtures. Use reserved example domains and no customer data.

## Exercise the actual component

Create typed fixtures at the existing props, mock, or API boundary. Never edit markup or CSS to manufacture a failure. Mix applicable cases across visible rows: long and short names, unbreakable identifiers, optional fields absent, every supported status, large and singular counts, Unicode and emoji, and missing or failed images.

Also cover empty, one, page-boundary, loading, error, partial-data, and realistic large collections. Select only cases the changed component can render. Do not run unrelated screens or a full catalog sweep for a small fix.

Use the repository's existing story, fixture switcher, test route, or isolated preview. Add a Demo / Worst case selector only when it helps inspection. Keep it outside production routes and bundles, use existing primitives, and retain selection in the URL when supported. Do not add an optional environment variable or leave test controls in the shipped UI.

## Inspect and fix

Use the real running component at its actual container width, its supported narrow and wide layouts, and 200% zoom or enlarged text. Check dark mode, RTL, and touch access only where supported. For terminal UI, use the actual TUI with narrow/wide columns, wide characters, resize, themes, and keyboard navigation instead of browser-only checks.

Look for clipped or unreadable text, shrinking icons, unreachable actions, ambiguous truncation, raw missing values, wrong plurals, bad number/date formatting, broken media fallbacks, layout jumps, and large-list stalls. Capture the same scenario before and after any fix. Record observed behavior separately from CSS inference. Without a usable runtime, report NOT VERIFIED rather than treating inference as visual proof.

Keep existing design tokens and components. Choose wrap, clamp, or truncation per field; full identifying information must remain accessible. Do not hide a meaningful number or date to make the layout fit. Recheck normal fixtures as well as worst cases after each coherent fix batch.

## Report and retain proof

Give one row per finding with severity, field/value, observed failure, proposed fix, and file:line. Separate real product decisions from defects, then name what already held up. Include the fixture route or command and the tested revision and layouts. A short report with no failures is valid.

Keep useful fixtures or tests that catch the actual break. Prefer the repository's existing regression framework; do not add production debug controls or screenshot pins that duplicate stronger tests. The full requested acceptance flow and repository-required checks still run afterward.

At task end, stop task-owned test servers and browsers and remove transient controls. Leave a demo running only if explicitly requested, with its teardown command. Do not finish with an unsolicited "say fix all" offer during authorized implementation.
