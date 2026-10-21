### Bug fix

**You own this task. Plan, review, verify.** A concrete small fix can have one owner. Separate investigation and review when genuine unknowns or risk justify it and the active tool contract permits workers.

Be scientific. Every shipped line traces to runtime evidence. Belt-and-suspenders that "might help" is a hypothesis, not a fix; it does not ship. When evidence refutes a hypothesis, revert what it motivated. The smallest change the evidence justifies ships, nothing more. Same discipline for Perf, where the evidence is the trace.

1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables). Don't hand the repro to the user. A debug or instrumentation protocol that says to ask the user does not override this; you drive the instrumented runtime. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. Won't reproduce directly, force it: synthesize the trigger, tighten conditions, or instrument until it fires. A bug you can't reproduce, you can't prove fixed.
2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with a herdr watcher or pi goal mode. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out; a design grounded on a plausible-but-unconfirmed cause can be unanimously wrong while the real cause sits one subsystem over.
3. Plan the fix from the confirmed mechanism and name its data shape. Use `architect` for unresolved material alternatives, not merely a function boundary. Implement directly or use a justified, scoped `role: "bug-fix"` worker under the active tool contract. Apply the mode's risk-based independent review gate before shipping.
4. Verify on the same surface; the original repro now passes. "Inconclusive" or wrong-surface is not a pass; flag it. Unit tests show branch behavior, not bug absence.
5. Capture the failing repro before the fix. When commits are authorized, stage them so that evidence precedes the fix in git history; the diff tells the story. See the **tdd** skill for the failing-test-first cadence when the bug has a cheap local test path; skip it when the test would be expensive, integration-heavy, or unclear.
   This is the canonical **sequence-verifiable-units** principle skill, the failing test first and the fix on top.
6. Run **Opening a PR**.

Fan out read-only `how` and `why` investigation only when they address independent unknowns and the active tool contract permits it. Known root causes do not need repeated exploration.

For changes to UI layout, rendered data, or states, run the **break-ui** skill on the changed component before the final acceptance check. Keep fixtures typed and isolated from production. Recheck normal and worst-case states after fixes; this does not replace the full requested flow.

**Reply:** what was broken, root cause, fix, how you verified. Paste failing-then-passing repro output verbatim.
