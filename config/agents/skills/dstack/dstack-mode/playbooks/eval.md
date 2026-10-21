### Eval

**You own the experiment design. Plan, blind, run, synthesize.**

Evals test how a change affects agent behavior before promoting it: a new skill variant, a structural change, a prompt tweak. The failure mode is the observer effect. An agent that knows it's being evaluated behaves differently, so candidates must run blind.

**Non-negotiables for blinding:**

- No `eval`, `test`, `judge`, `experiment`, `rubric`, `score`, `compare`, `benchmark`, `candidate`, or `arena` in any directory, file, or prompt the candidate sees.
- The candidate prompt looks like an organic user request. State the goal, not the meta. "build me a small todo cli" not "show me how you follow the principles chain".
- No chain-eliciting cues. Don't ask the candidate to list which skills, principles, or files they applied; that meta-prompt inflates citation behavior. Ask for design notes generally and grade chain-following from code shape, not self-report.
- Sanitize directory and slug names. Use project-shaped names a user might pick, not labels like `candidate-1` or `agent-a`.
- Don't tell the candidate other candidates exist.
- The judge can know it's judging but sees outputs by sanitized label only, never by model name.
- Comparing two variants: one judge scores both sets in a single pass on one scale, blind to which set each came from. Two judge runs with different prompts don't compare, the calibration drifts.

**Steps:**

1. **Frame.** State the intended improvement and falsifiable success predicate before implementation. Grade completion of the original request, boundary and error handling, and unsupported completion claims. Extra planning fields, tool calls, or principle citations are not success. Freeze the rubric, baseline, trial count and held-out checks before inspecting results. Write the rubric (3-6 concrete criteria) for the judge only. Hold it back from candidates.
2. **Set up sanitized environments.** Per-candidate working dir with the variant in place. Plant any context an organic task would have: a project skeleton, the skills the candidate would naturally read.
3. **Author one organic prompt.** What a user would type. No leakage of what's being measured.
4. **Run repeated paired trials** of baseline and changed variants on the same model and configuration, with the same task inputs, limits and tools. Counterbalance trial order. Give every trial an isolated sanitized directory. Keep held-out checks out of candidate context and do not tune on unjudged runs. For a skill-only comparison, change only the skill text and keep the toolset fixed in both arms. Different-model assignment to baseline and changed variants confounds the comparison. If testing several production models, pair both variants within each model separately. Use the **arena** skill only for orchestration, not cross-model variant assignment.
5. **Spawn one blinded judge** on a different model family per the **arena** skill's Phase C. Judge sees outputs by sanitized label and the rubric, never a model name.
6. **Verify the chain from transcripts, not self-report.** Read each candidate's local transcript under the pi sessions directory for this cwd (`~/.pi/agent/sessions/<cwd-slug>/`). Do not glob across other cwd slugs; that crosses workspace boundaries and reads private chats from unrelated projects. Look at which files each candidate actually opened. Citing a principle is not reading its leaf skill, and reading it is not applying it. Grade chain-following from the files it really read plus the shape of the code, never from the candidate's own claims.
7. **Read every candidate output yourself** end to end. Compare to the judge's verdict. Disagreement means a model is biased or the rubric is ambiguous. Synthesize. Recommend promotion only when repeated paired results meet the frozen predicate. Retain stopped, blocked, and failed attempts without scoring them as successes. Component checks and results from a different variant do not validate this one.

**Reply:** variant under test, rubric, per-candidate notes, judge's verdict, your synthesis, and a recommendation for whether to promote the variant.

**Reporting nondeterministic results (always, not optional).** Any eval of LLM or otherwise nondeterministic behavior — model-arm benchmarks included, not only variant experiments — ships two blocks wherever the results land (reply, PR description, report file):

1. **The results table.** One row per model arm; columns: deterministic pass rate (n/N and %), judged correctness, judged quality, cost per trial (credits, and USD when known). A comparison run includes the baseline arm or a trajectory table; a number without its baseline in the same table is not a result. Judge blind spots (channels or surfaces the judge cannot see) are footnoted on the table, never silently zeroed into the scores.
2. **The failure section.** Every failing case named, per arm, with the cause read from the trial artifacts — what the model did, which error or guard fired, and which known class it belongs to. The table without the failure list hides the signal; the failure list without the table hides the scale.
