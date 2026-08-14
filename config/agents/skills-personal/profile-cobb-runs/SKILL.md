---
name: profile-cobb-runs
description: Profile Cobb agent runs and Builder V4 vertical-onboarding eval batches. Use when investigating run latency, parallel tools, decisions, credits, cost, token use, payload size, pending or errored spans, pricing attribution, or comparing onboarding template runs.
---

# Profile Cobb runs

Run commands from the Cobb repository root through `direnv exec .`. Keep output bounded: begin with `summary` or `diagnose`, list filtered spans next, and only load raw event payloads for a selected span.

## Profile one run

```bash
direnv exec . cargo run --bin run-profile -- --run-id <RUN_ID> summary
direnv exec . cargo run --bin run-profile -- --run-id <RUN_ID> diagnose --limit 10
```

The canonical profile is the same Rust model used by Goodview's Timeline tab. It includes paired decision, tool, computer-use, and instant-event spans; exact `parallel_for` children; stable span and parent IDs; duration and concurrency; credits and estimated cost; tokens; payload sizes; pricing-attribution confidence; idle time; warnings; and unattributed charges.

## Query spans

```bash
direnv exec . cargo run --bin run-profile -- --run-id <RUN_ID> spans \
  --kind tool --sort duration --limit 25

direnv exec . cargo run --bin run-profile -- --run-id <RUN_ID> spans \
  --status pending --limit 25

direnv exec . cargo run --bin run-profile -- --run-id <RUN_ID> spans \
  --name scrape --sort credits --limit 25

direnv exec . cargo run --bin run-profile -- --run-id <RUN_ID> spans \
  --parent 'tool:<PARENT_CALL_ID>' --sort start --limit 100
```

Valid kinds are `decision`, `tool`, `computer-use`, and `event`. Valid sorts are `start`, `duration`, `credits`, and `size`. Valid statuses are `completed`, `pending`, `errored`, and `instant`.

## Drill into one span

Use the stable `id` returned by `spans`. This is the only command that returns the selected span's raw start/end event payloads.

```bash
direnv exec . cargo run --bin run-profile -- --run-id <RUN_ID> span '<SPAN_ID>'
```

Do not dump an entire run's raw events when span IDs can narrow the investigation.

## Compare runs

Create a typed JSON manifest:

```json
{
  "runs": [
    { "label": "baseline", "run_id": "<RUN_ID>" },
    { "label": "candidate", "run_id": "<RUN_ID>" }
  ]
}
```

Then run:

```bash
direnv exec . cargo run --bin run-profile -- compare /tmp/run-profile-manifest.json
```

Compare duration, max concurrency, idle time, credits, estimated cost, tokens, payload bytes, unattributed credits, and warning counts. Follow up on regressions with filtered `spans` and `span`.

## Run isolated Builder V4 onboarding templates

The template harness creates a fresh eval user and agent per trial, supplies the committed wizard answers, launches the production typed template task, starts Builder V4, and stops on the observable first-value yield. Builder V4 never finishes by design; never wait for a final build state or call `finish_build`.

The harness uses real providers. Confirm the user intends to incur provider usage before running it. Use a unique report label and output directory.

```bash
ANTHROPIC_API_BASE=https://api.anthropic.com \
CHAT_AUTO_NAME_ENABLED=false \
MAILGUN_API_URL=http://127.0.0.1:18081 \
direnv exec . cargo run --bin template-eval -- \
  --task <CASE_ID_OR_TEMPLATE_SLUG> \
  --max-parallel 1 \
  --suite local_vertical_profile \
  --output /tmp/vertical-profile.json \
  --events-dir /tmp/vertical-profile-events \
  --report-label vertical-profile-<UNIQUE_SUFFIX>
```

## Model and reasoning-effort arms

One harness process pins one configuration: `--policy-model` pins the run's policy model (bypassing the production hash allocation), and `--kimi-reasoning-effort` (low, medium, high; requires `--policy-model kimi-k3`) pins Kimi's thinking effort on the harness's in-process policy worker. Production is unaffected; the knob is eval-only. Run one invocation per arm with distinct `--report-label`s and output paths.

Arm processes are safe to run concurrently: each harness boots an isolated in-process stack (UUID-suffixed Postgres database cloned from the migration template, in-memory message buses, ephemeral service ports, temp SQLite dirs). Per process you only need a distinct loopback `MAILGUN_API_URL` port (18081, 18082, ...), a distinct `--report-label`, and a distinct `--output`; a shared `--events-dir` is fine because artifacts are namespaced by report label. Build once with `cargo build --bin template-eval`, then invoke `./target/debug/template-eval` in each pane so concurrent arms do not contend on the cargo build lock. Pass eval env overrides through `direnv exec . env K=V ... ./target/debug/template-eval ...` so they land after direnv's own exports.

**Affinity salting is mandatory for concurrent kimi arms.** Fireworks session-affinity keys are template-scoped for template launches, so concurrent trials of the same template would all pin to one replica and destroy each other's prompt cache (~2–3× latency and credits from `miss × congestion`). The harness salts the key per process via `--affinity-salt`, which **defaults to the report label** — distinct report labels per arm therefore give each arm its own replica automatically. Verified: three concurrent salted trials of one template each matched the solo baseline (≈13–18s/decision, 93–96% cache hits) where unsalted concurrency degraded to ~30s/decision. Within one arm, trials of the same template share that arm's replica by design (they warm each other), so keep `--max-parallel` at 3 or below per arm. Production keys are unsalted and unaffected.

The canonical effort sweep is four arms — kimi low/medium/high plus an opus baseline — launched concurrently in adjacent panes, which also satisfies the requirement that kimi arms run close together in time (comparable provider congestion and prompt-cache warmth):

```bash
COMMON='--vertical real_estate --max-parallel 3 --events-dir /tmp/<BASE>-events'

# Arms 1-3: kimi at pinned low / medium / high effort (one process each,
# distinct MAILGUN_API_URL ports 18081-18083)
direnv exec . env ANTHROPIC_API_BASE=https://api.anthropic.com \
  CHAT_AUTO_NAME_ENABLED=false MAILGUN_API_URL=http://127.0.0.1:18081 \
  ./target/debug/template-eval --policy-model kimi-k3 \
  --kimi-reasoning-effort low --model-label kimi-low \
  --resolved-model accounts/fireworks/routers/kimi-k3-fast \
  --report-label <BASE>-kimi-low --output /tmp/<BASE>-kimi-low.json $COMMON

# Arm 4: opus baseline (port 18084, no effort flag)
direnv exec . env ANTHROPIC_API_BASE=https://api.anthropic.com \
  CHAT_AUTO_NAME_ENABLED=false MAILGUN_API_URL=http://127.0.0.1:18084 \
  ./target/debug/template-eval --policy-model opus5 \
  --model-label opus-default --resolved-model claude-opus-5 \
  --report-label <BASE>-opus --output /tmp/<BASE>-opus.json $COMMON
```

Before comparing, check each report's `cases[].observed_policy_models`: a kimi-arm trial that shows a substituted model (health-gate flip or busy fallback) is not a valid sample for that arm and must be dropped.

Stage the scope: run `--vertical real_estate` first — it is the hardened, best-instrumented vertical (27 cases) — and extend the surviving arms to `--all` only if the real-estate signal is ambiguous. A full `--all` sweep is ~97 cases per arm against real providers; confirm the spend before launching it.

```bash
# One vertical
... template-eval --vertical real_estate --max-parallel 3 <OTHER_ARGS>

# Every vertical
... template-eval --all --max-parallel 4 <OTHER_ARGS>
```

`--cases-dir` remains available for a custom case set and conflicts with `--task`, `--vertical`, and `--all`. `--case-filter` can further narrow the selected cases.

After the harness returns, read `cases[].run_id` from its report, write those IDs into the comparison manifest above (label arms like `kimi-low`, `kimi-medium`, `kimi-high`, `opus-default`), then use `compare`, `diagnose`, and targeted span drill-down. For effort arms specifically: `compare` shows total duration, output_tokens, and credits per arm (lower effort should cut thinking tokens, so watch output_tokens and per-decision duration); `spans --kind decision` shows whether the saving came from shorter decode (smaller output_tokens at similar TTFT) or was masked by cache misses (check cached_tokens per decision before attributing differences to effort). Preserve eval artifacts in ignored private paths because event payloads and reports can contain PII.

## Latency metrics for effort sweeps

Report two latency numbers per arm, never one:

- **Time to first yield (first value)** — the report's `wall_seconds`: trial start until Builder V4 first yields to the user (`first_value_status` of `Yielded`, `OpenUserQuestion`, or `FailureGuidance`; `Timeout`/`HarnessError` trials are failures, not latency samples).
- **Time to first report block** — derived from the per-trial events file: run start until the first report deliverable / `agent_report` event. This is user-perceived "it's working" latency and can be absent when the run yields with a question instead.

Also report the Δ (report → yield, the finalize-turn overhead) and the `first_value_status` distribution per arm. There is no "time to final report": Builder V4 never finishes by design, and the harness stops polling at the first yield. Do not wait for, assert, or try to time any finalization signal.

Summarize per arm × vertical over valid samples only (after dropping substituted kimi trials): sample count, first-value success rate, deterministic-check pass rate, median/p90 of both latency metrics, median credits, and median output tokens per decision.
