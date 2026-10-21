# Outcome proof pilot

## Result

The behavioral experiment is inconclusive. It does not establish that this patch improves task completion, prevents corrective prompting, or improves application architecture. The registered acceptance predicate was not met.

One matched development pair ran on a private historical workload. Both agents reached the same catalog-cost stop trigger before a settled final handoff. Both produced artifacts that passed the shared independent acceptance checks. Both also left a failing agent-added regression test. Different test selections had different denominators, so their aggregate pass counts are not an uplift comparison.

| Observation | Aggregate result |
| --- | --- |
| Substantive development attempts | 2, one per arm |
| Catalog-cost stops | 2 |
| Settled final handoffs | 0 |
| Artifacts passing the shared independent acceptance set | 2 of 2 |
| Artifacts with all discovered tests passing | 0 of 2 |
| Completed proof-tool executions in the task replays | 0 |
| Coding-model catalog estimate for the two attempts | About USD 4.05 |
| Fresh final-validation attempts | 0 of 24 required |

Neither attempt reached a final handoff, so these attempts do not establish better completion-claim accuracy. Passing the independent checks also does not turn a stopped attempt into an accepted outcome.

## Method

The arms used the same starting source, original request, model, provider, effort, common tools, dependencies, visible paths, and per-attempt limits. Each had isolated writable source, policy, state, and history. The treatment added the outcome tool and changed guidance. Baseline ran first. The order was not counterbalanced, and elapsed times do not support a speed claim.

The independent checks exercised production owners and distinguished the original implementation from a historical control before candidate outputs were observed. The control was a sensitivity check, not a required patch. The generic draft and acceptance harness were developed in parallel, so quantitative replay baselines did not guide the initial implementation.

The native replay environment omitted delegation and interactive terminal orchestration in both arms. Results do not describe the complete interactive dstack environment. The four workloads were selected from known historical difficulties, not a representative sample of all engineering tasks.

The original final predicate required three fresh matched pairs on each of four workloads. Every final treatment attempt had to satisfy the original acceptance without corrective prompting, establish a falsifiable outcome before production edits, meet concrete boundary and error requirements, run decisive matching checks, and avoid unsupported VERIFIED claims. It also required prevention of an observed failure mechanism without regressions. None of those final trials ran. Three workloads lacked decisive executable acceptance or safe application-model transport under the registered call cap. They remain blocked, not scored as successes or quietly removed from the predicate.

## What the mechanism establishes

The generic regression suite executes real checker processes against synthetic local artifacts. It covers failed assertions, malformed observations and receipts, stale or wrong-target evidence, changed checker identity, missing coverage, cancellation, bounded capture, branch ownership, and persistence failure recovery. This is evidence about the proof mechanism, not evidence of better agent decisions.

A separate deterministic provider drove the actual Pi CLI through schema rejection, proof execution, context refresh, cancellation, new sessions, forks, reload, cold resume, and publication failure recovery. It passed on the installed 0.99.1 runtime and the configuration-pinned 1.3.0 runtime without paid model inference. This private integration probe is not part of the public regression suite.

Independent review exposed deadline and publication defects. A descendant could hold captured pipes open past a deadline. A failed session write could leave a receipt visible only in memory. Repairs address both, including persistence uncertainty across extension reloads. These repairs occurred after the frozen treatment replay. The final patch has not received a new matched behavioral replay.

Pre-edit admission, criterion relevance, baseline quality, application architecture, and arbitrary prose claims remain instructions or review obligations. The mechanism cannot infer that agent-selected checks prove the user's complete goal. It is not a sandbox, a deployment gate, or a guarantee that every descendant process stops.

The reproducible public check is `bun test config/pi/agent/extensions/pi-todos`. Private source, requests, fixtures, individual diagnoses, and transcripts are not included. No machine configuration was applied and no deployment was tested.
