---
name: run-evals
description: "Run or improve an existing eval suite with realistic cases, human-reviewed scoring, matched baseline comparisons, native hc background agents, and a sealed unseen check. Use for running evals, validating a prompt or skill change, or hillclimbing against a fixed target."
---

# Run evals

Take an eval request through preparation, execution, improvement, and a report. Reuse the repository's runner and review tools. Do not build another evaluation framework.

Use `/skill:run-evals` followed by the behavior, baseline, candidate, existing suite or dataset, and limits you know. Discover missing implementation facts yourself. Ask only for missing authorization or a genuine product decision.

For paired trials and blinding, read [Eval](../../dstack-mode/playbooks/eval.md). For repeated improvement, also read [Hillclimb](../../dstack-mode/playbooks/hillclimb.md). Follow the shared [native hc contract](../../dstack-mode/references/native-agents.md) for delegation throughout this runbook, not the removed subagents extension. Judge-specific steps apply only when the chosen scoring method needs a judge.

## Keep one campaign record

Reuse the runner's existing artifact formats. Record the protocol, case and split identities, proposed and verified labels, every attempt, iteration decisions, and final report. Keep private data and raw outputs outside Git.

Apply the spend rules in step 4 before any paid preparation, including collection or labeling. Finalize cases and labels before comparative inference.

Track preparation, execution, and acceptance separately. Use `NOT RUN`, `RUNNING`, `BLOCKED`, `INCONCLUSIVE`, `REJECTED`, or `ACCEPTED` with evidence. Passing runner tests is not a completed model eval. A development pass is not unseen validation.

## 1. Define the outcome and select the runner

Read repository instructions and existing eval skills, case catalogs, commands, and recent results. Find the production path that must change.

State the user-visible improvement, the baseline revision or configuration, the candidate, and what would disprove success. A baseline is an implementation, not a dataset split.

Choose the verification needed:

- Deterministic checks for exact outputs, state transitions, persistence, and error contracts.
- Behavioral evals for model decisions, prompt effects, reliability, or quality.
- End-to-end checks for the actual saved result, rendered application, delivered message, or intended handoff.
- Human review for requirements that executable checks do not settle.

Reuse the existing runner if it measures this claim. For historical coding tasks, restore the recorded starting source, not today's already-fixed application. Read the workbench's current case-status documentation. Packaging does not make a blocked case runnable.

If the runner tests a weaker substitute, name the gap and repair only what prevents a valid comparison. Do not count that repair as improved model behavior.

## 2. Prepare realistic cases and independent splits

Prefer sanitized production cases or faithful historical replays. Include failures, ordinary successful cases, negative controls, and relevant workload extremes. Do not collect only known failures and call the pooled result a production success rate.

Record each case's source, selection reason, input boundary, expected outcome, and available evidence. Preserve the history and state available at the decision point. Exclude future messages and reference answers from prediction inputs.

Assign related conversations, incidents, users, and near-duplicates together before tuning. Keep these roles distinct:

- Working cases permit diagnosis and prompt or implementation changes.
- Validation cases support candidate selection. Treat them as selection data, not final proof.
- Unseen cases remain outside development until the final comparison.

For fresh unseen data, use at least one separate native background agent as collector and custodian. Give it only approved sources, sampling rules, the frozen labeling criterion, exclusions, and permitted outputs. Read [Native agents](references/native-agents.md) before launching it.

Do not open its cases, labels, rationales, or raw transcripts while optimizing. Receive only counts, integrity checks, readiness, and the human review location. Reuse an existing sealed set only after its custodian verifies that it was not used for development.

Stay within the authorized users, machines, date range, data access, and provider permissions. Missing permission blocks collection, not unrelated offline preparation. Never put raw production content or credentials in a public report or Git commit.

## 3. Establish reference judgments

Keep model suggestions, human decisions, and verified labels separate. A labeling model proposes answers. It does not create ground truth by itself.

Use the existing review interface where available. Let the human correct labels and record ambiguity, acceptable alternatives, or missing context. Preserve review provenance and version corrections.

Blind annotation hides model suggestions until the human decides. Reviewing visible prefills is assisted annotation. Neither alone establishes that the cases are held out from development.

For exact human-labeled decisions, score with code. Do not add another LLM judge by default.

For subjective quality, define concrete criteria with human examples. Calibrate any judge against separate human-reviewed examples, inspect disagreements, and freeze its version before comparing candidates. Keep factual fidelity and task completion separate from style or design preference. A judge cannot override a failed required check.

If labels change, version them and rescore every compared arm. Do not change labels selectively to favor a candidate.

## 4. Freeze the comparison protocol

Before comparative inference, record these inputs in the campaign's existing protocol format:

- Outcome, primary metric, correctness and regression gates, and tie-breakers.
- Baseline and candidate source identities, including relevant dirty changes.
- Case versions, split membership, label versions, and judge version when used.
- Runner command and revision, tools, model, provider, reasoning effort, relevant context, inference settings, and cache policy.
- Trial count, repetitions, arm order, concurrency, execution limits, and retry policy.
- Spend and wall-clock limits, stop triggers, and the confirmation required to accept a win.
- Final unseen comparison and end-to-end acceptance commands.

Use the configured production model when making production-model claims. For a skill-only comparison, hold model, tools, inputs, and limits fixed. Pair variants within each model when comparing several models.

Choose repetitions for the observed noise and decision stakes. One run is diagnostic. Repeated predictions are not additional independent cases.

Before paid work, state cases × arms × repetitions, expected cost and duration, and the done predicate. Include collection, labeling, judge, worker, and application-model calls. Follow repository confirmation requirements. If no usable spend limit is supplied, establish a bounded plan rather than assume unlimited permission.

## 5. Prove the runner, then smoke and run

Check fixture validity, score calculation, model identity reporting, error propagation, and artifact capture without provider calls first. Use known correct and incorrect controls to confirm that scoring can distinguish them.

Run a bounded live smoke before the full sweep. Verify that it exercises the shipped schema and intended application path. Stop the sweep if collection, scoring, required inputs, or model identity is wrong.

Run repeated paired baseline and candidate trials on the same cases. Counterbalance arm order where appropriate. Isolate mutable task state between trials. Give task agents organic requests without grading criteria, reference fixes, other arms, or previous results.

Use `hc run` for finite commands. Use `hc run --bg` for native agents, then `hc wait` and scoped reads. Do not use print-mode agents, sleep polling, or the removed extension. Inspect launch acknowledgement and real completion, not an echoed command or an agent's claim.

Record actual outcomes, serving model, token usage, elapsed time, and accounted cost. Retain errors, cancellations, stopped attempts, and partial runs. Do not silently retry unchanged failures or drop them from the denominator.

## 6. Score and inspect the failures

Compare every arm against the same frozen labels and rubric. Report deterministic correctness, judged quality when measured, latency, and cost separately.

Inspect the saved evidence for each failure. Distinguish broken collection, missing context, retrieval misses, model choices, invalid outputs, application delivery failures, and judge limitations.

Do not infer completion from a terminal run-status field when the application intentionally stays open. Check the outcome named in the protocol.

If the harness or scoring changes, version the change and rerun affected arms. Earlier numbers from a different measurement are not directly comparable. Retain the original results and explain any protocol amendment.

## 7. Hillclimb only on development data

Skip this step with a reason for a one-shot comparison. Otherwise follow the Hillclimb playbook with the frozen protocol.

Change one hypothesis at a time. Record its mechanism, exact change, before and after, regression results, cost, and keep or reject decision. Keep the criterion fixed while varying the candidate.

Evaluate the whole working set, including negative controls. Do not improve positive-case recall by silently increasing harmful false positives. Confirm promising changes with repeated unchanged runs.

Stay within the declared limits. A budget or deadline stop is a stopped search, not acceptance. Do not relax the predicate or discard failures to announce a win.

## 8. Select, freeze, and evaluate unseen data

Select the finalist using validation data. Freeze the complete candidate and pass rule before the custodian runs baseline and candidate on the sealed set.

The predictor receives each case's input, never its reference label. The optimizer receives only the permitted summary until the final comparison is complete. Reference labels must be verified even though the set is unseen to the optimizer.

If independently reviewed cases or a faithful runner are missing, report `BLOCKED`. Do not relabel working examples as unseen or rerun until the test passes.

Preserve a failed unseen verdict. If its cases, labels, or errors inform another change, move them into regression material and reserve fresh unseen evidence. Never call the next result on those same cases an untouched test.

## 9. Verify the real outcome on the final revision

Exercise the actual application path with the frozen winner and relevant failure paths. Inspect the persisted file, rendered interface, delivered payload, or first useful handoff that the original request needs.

Verify the final matching revision, not a helper demonstration or an older served build. Keep a scripted plumbing check separate from real-model behavior evidence. Mark requirements that cannot be checked as unverified.

Do not deploy, write production data, contact customers, or delete cases or outputs without the required authorization. Stop only task-owned processes. Preserve evidence and record any intentionally retained service and its teardown command.

## 10. Report and hand back

Lead with `ACCEPTED`, `REJECTED`, `INCONCLUSIVE`, or `BLOCKED` for the original claim. Show the baseline and candidate in the same table.

Include cases and unique-case counts per split, trials attempted and completed, deterministic pass rate as n/N, judged correctness and quality when measured, latency, cost per trial, and total accounted cost. Mark unmeasured fields explicitly. State judge blind spots and scope limits beside the results.

Name every failing or inconclusive case per arm with its evidence and cause. Include the iteration log, exact tested configuration, actual model identity, commands, exit statuses, and private artifact locations. Separate diagnostic, development, unseen, and end-to-end evidence.

Keep production changes separate from bulky eval tooling and private artifacts. Follow repository policy for required checks, issues, commits, and PRs. Running this skill does not itself authorize a commit, PR, merge, or deployment.
