# Pi todos

The `todo` tool owns one structured task plan. Like Pi's todo example, updates appear as themed checklists in the conversation instead of a pinned editor widget. `/todos` opens the complete checklist with notes and blocked/skipped reasons. `j`/`k` or arrow keys scroll down/up, Page Up/Down scroll by a page, and Escape closes. These keys apply only while the checklist is open. `/todos list` and `/todos show` also open the checklist. `/todos show` and `/todos hide` retain the legacy visibility setting for saved-session compatibility; neither adds a widget.

Use `replace` with `{ title, items }` to start a plan, `update` with a full item to change one step, `list` to read it, and `clear` to remove it. Items have stable positive integer ids, text, and `pending`, `doing`, `done`, `blocked`, or `skipped` status. Blocked/skipped items require a reason. Optional notes do not select a state. Retrying an update sets the same status rather than toggling it.

Each mutation persists a `dstack-todos` custom session entry. This works when the tool is called directly or inside codemode, where nested tool results are not transcript entries. The checklist reads the active branch; existing visibility fields remain compatible with saved snapshots. Todo actions and the checklist do not save user messages or start another agent turn.

For old sessions without a native snapshot, the extension reads array-shaped `*Todos` keys from `codemode-store` entries. Only `{ step, status }` rows qualify. Exact known statuses and explicit skip/block prefixes are recognized; unfamiliar status prose becomes pending with the original text in notes. It is never guessed as completed. Deleting the selected key clears it. Native snapshots take precedence, including a deliberate clear, so legacy state cannot resurrect a cleared plan.

Every model context request receives one hidden, request-local reference reconstructed from the active branch. It includes the title, every stable id and literal status, all notes, and blocked or skipped reasons, regardless of visibility. A clear produces `No active saved todos.` The reference is not saved to the session and does not start a turn or authorize work. Current user instructions win, and saved `done` status is not proof. Automatic continuation is not part of this extension.

## Prove an intended outcome

The adjacent `outcome` tool leaves the todo API unchanged. Tiny, casual and read-only tasks need no contract. For implementation work, create a checker first, then call `begin` before editing the implementation. The contract freezes the requested input-to-result flow, scope, relevant inputs, target artifacts, criterion IDs, checker files, argv, bounds and expected observations. `amend` replaces the contract with a new revision and invalidates proof. `block` records an honest blocker. `clear` ends tracking without deleting historical receipts.

A minimal contract looks like this:

```json
{
  "action": "begin",
  "contract": {
    "request": "The parser rejects a negative count and preserves zero",
    "scope": "Local parser behavior on the checker's cases only",
    "inputs": ["src", "package.json", "bun.lock"],
    "targets": ["src/count.ts"],
    "criteria": [{
      "id": "count-boundary",
      "claim": "Exercise the actual parser with negative and zero inputs",
      "command": ["bun", "checks/count.ts"],
      "verifierInputs": ["checks/count.ts"],
      "timeoutMs": 10000,
      "expect": {"kind": "equals", "value": "negative rejected; zero preserved"}
    }]
  }
}
```

The checker imports or invokes the actual target, asserts the behavior and exits nonzero on failure. Its stdout must contain only `{"kind":"text","value":"negative rejected; zero preserved"}`. Diagnostics go to stderr. A numeric checker emits `{"kind":"metric","value":12}`. Its expectation uses `{"kind":"metric","baseline":20,"direction":"lower","target":15,"unit":"ms"}`. Record a measured baseline, not a guessed score. The mechanism checks the observation against that target, not the quality of the baseline measurement.

After implementation and any build, call `outcome` with `{"action":"prove"}`. This executes every frozen criterion in the workspace, then compares before and after fingerprints. Use `{"action":"status"}` immediately before reporting scoped VERIFIED. Every model context request also rechecks current evidence. A changed checker requires `amend`. Failed, signalled, timed-out, cancelled, malformed, incomplete or stale evidence cannot produce VERIFIED. No external receipt import or model-supplied success flag exists. Malformed or missing private evidence fails the tool rather than becoming a passing result. If a session-entry write throws, that session stays fail-closed in the current Pi process until an explicit `clear` succeeds. Navigation and extension reload do not reset this persistence latch. A process restart restores the entries that reached disk.

Declare all relevant source, fixture, configuration and dependency-lock inputs. Directory fingerprints include dirty and untracked bytes, modes and names, not only HEAD. Include the actual built artifact when claiming behavior of a build. Checks must not rebuild or modify declared inputs or targets during proof. Use real workspace-relative paths. Symlinks and scopes above 20000 entries or 256 MiB are rejected. Each of at most 16 criteria has a deadline of at most 120 seconds. Output above 10 MiB stops the process and invalidates proof. Observations above 64 KiB cannot verify.

The runner records process exit events or stop triggers, timestamps, argv, executable hashes, environment digest, contract identity, declared coverage and bounded stdout/stderr. Private receipts and logs live under `<agent-dir>/outcome-proofs`, with directory mode `0700` and file mode `0600`. They are not repository artifacts or automatically published. Session entries contain the contract and opaque receipt reference, not full logs. Restrict access to session files too. Deadlines and cancellation stop capture without waiting for inherited pipes to close. The runner kills the original process group where supported, but escaped descendants may continue. Nothing here is a sandbox or tamper-resistant against another process running as the same user.

VERIFIED means the declared executable checks passed against currently matching declared local inputs. Agent-selected checks can be weak or omit relevant inputs. Passing them does not establish semantic adequacy, architecture, user value or deployment. Review those separately. This initial integration does not intercept edits, block arbitrary shell effects, force pre-edit admission, or continue the agent automatically. Free-text completion claims are not an authoritative proof transition.

The [pilot report](PILOT.md) separates mechanism checks from the inconclusive behavioral experiment.

Dstack uses the todo tool as its single todo source when available. Generic codemode storage remains for other task state. A fresh Pi session or `/reload` discovers the extension. No host rebuild or planning-mode tool restrictions are required.
