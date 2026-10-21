### Feature

**You own the parent goal. Plan, implement, review, verify.** Choose one writer and scale independent exploration and review to the unknowns and risk.

1. `how` over the affected subsystem. Record the requested input-to-outcome flow, acceptance criteria, and the revision/surface on which it will be proved.
2. Use `architect` when materially different designs remain unresolved. A concrete small extension needs a named data shape and a brief local design, not a panel. Keep `architect skipped: <reason>` explicit.
3. Write the throughput checkpoint as four todo items. A dimension that genuinely does not apply (single file, no fan-out) keeps its item with `n/a: <reason>` rather than being dropped:
   - **Blocking first steps.** Gates run before fan-out.
   - **Independent workstreams.** Disjoint files, services, or layers parallelize. Shared writes serialize.
   - **Shared mutable state.** Default to splitting the target (the **separate-before-serializing-shared-state** principle skill). Serialize only for real invariants.
   - **Smallest safe decomposition.** If one worker is best, name why.
4. Implement with one owner per writable checkout/branch. Use a scoped `role: "feature"` worker when it creates real separation and the active tool contract permits it; otherwise own the diff directly. Choose the data shape before logic per **principle-model-the-domain**. Use `arena` only for material alternatives, not routine error handling or test placement. Review artifacts, port shared changes to affected consumers, and preserve unrelated work. Worker completion never completes the parent task.
5. Prove the full acceptance flow on the matching built revision. Component assertions, a rendered preview, or green CI alone do not prove the feature. Model-behavior claims need the matching repository eval on its configured production model. Mark blocked or wrong-surface proof NOT VERIFIED or INCONCLUSIVE.
6. Keep verifiable units and their evidence ordered per **sequence-verifiable-units**. Commit or rebase only when shipping is authorized; do not rewrite unrelated live work.
7. Apply the mode's risk-based independent review gate before shipping. Authorization, secrets, money, concurrency, recovery, compatibility, or broad cross-layer changes need adversarial review even when the design is agreed. A small low-risk change can use a focused diff review. Report permission-blocked independent review honestly.
8. Run **Opening a PR**.

Code-coupled work (one feature, one migration) goes to a single owner with the checkpoint inline; that owner fans out internally after the blocking phase. Parent-level fan-out is for slices that produce independent artifacts (audits, cross-subsystem investigations, competing experiments). Rewrite the checkpoint at phase boundaries; spawn a fresh owner rather than chaining interrupts.

For changes to UI layout, rendered data, or states, run the **break-ui** skill on the changed component before the final acceptance check. Keep fixtures typed and isolated from production. Recheck normal and worst-case states after fixes; this does not replace the full requested flow.

**Reply:** what you built, what you chose and why, open decisions. Tables for design alternatives.
