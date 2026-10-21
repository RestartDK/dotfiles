### Repro

**You own a minimal failing reproduction with evidence. The deliverable is the repro, not the fix.** For "reproduce this", "this run failed", a prod run URL, a bug report with logs, or any defect you cannot yet trigger yourself. Hands off to Bug fix once the repro exists.

1. Collect one bounded evidence bundle before touching code (the **principle-fix-root-causes** skill): incident window, affected identifiers, the exact failing behavior, and one explicit hypothesis. In cobb: `run-inspect` for the run timeline, state transitions, and exact LLM payloads; `bin/export-prod-run-events.sh` for raw event protobufs; axiom-logs or `journalctl` for service logs. The repo layer names the tools elsewhere.
2. Identify the exact triggering input or event. Reduce the bundle to the smallest slice that still contains the failure. Parse bulk artifacts in a subagent and keep the reduced finding in the main thread (the **principle-guard-the-context-window** skill).
3. Pick the cheapest surface that exercises the real path: a focused unit test, the integration framework, or the CLI against a local stack (run Stack-up first if needed). Cheapest that is still the *real* path; a mock that skips the failing layer proves nothing (the **principle-prove-it-works** skill).
4. Write the failing repro first, red before green, per the repo's red-green testing skill or the **tdd** skill. The repro fails for the same mechanism as the incident, confirmed against the evidence bundle, not just any failure in the same area.
5. Test the hypothesis with the cheapest discriminating check. Do not alternate between evidence queries and patches without stating what new evidence invalidated the previous hypothesis.
6. Hand off to the Bug fix playbook with the repro command, the evidence bundle, and the confirmed mechanism. Stage the failing test so the eventual fix diff tells the story.

**Reply:** the repro command and its failing output, the evidence that ties it to the incident, the confirmed or strongest-supported mechanism, and what Bug fix should start from.
