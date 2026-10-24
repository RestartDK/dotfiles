# Local PR jobs pilot

This Linux pilot keeps PR review and CI checks active after an interactive Pi session ends. A local daemon owns durable jobs. The CLI, Pi extension, and Herdr Jobs pane display the same state without model calls. The Home Manager service is optional and disabled by default.

## Commands

```sh
dstackd
dstack register --repo OWNER/REPO --pr 123 --source /absolute/checkout --mode observe
dstack register --repo OWNER/REPO --pr 123 --source /absolute/checkout --mode drive
dstack list
dstack status JOB_ID
dstack attach JOB_ID
dstack herdr
dstack herdr --notify
dstack stop JOB_ID
```

`register`, `list`, `status`, and `stop` return JSON snapshots. Admission commits the job and custom task together before returning its ID. An identical active registration returns that ID. A conflicting checkout or mode requires an explicit stop first.

`attach` and `watch` show current snapshots without model turns. `--json` selects structured connection updates. Disconnecting never cancels a job. Stop admits cleanup, which can remain pending if ownership or release cannot be verified.

`observe` reads GitHub only. `drive` authorizes repair commits and ordinary pushes to the registered PR's branch. Neither mode authorizes merging, rebasing, force-pushing, or changes to stack topology. A registration represents one explicitly selected frontier PR, not an automatically discovered stack.

## Session-targeted wakes

The same `dstackd` also owns timers and read-only GitHub check watches. These are deliberate scheduled requests for one native Pi session, not stale worker completion notices. They do not launch workers, migrate native conversations, or change PR-controller authority.

```sh
dstack wake create --in 5m --message "Resume the requested investigation" --session NATIVE_SESSION_ID
dstack wake create --at 2026-10-16T12:00:00Z --deadline 2026-10-16T13:00:00Z --message "Review the result" --session NATIVE_SESSION_ID --request-id reminder-1
dstack wake create --repo OWNER/REPO --pr 123 --message "Review these completed checks" --session NATIVE_SESSION_ID --request-id checks-1
dstack wake create --request-id reminder-1
dstack wake list
dstack wake list --session NATIVE_SESSION_ID
dstack wake status WATCH_ID
dstack wake cancel WATCH_ID
```

`--session` defaults to `PI_SESSION_ID` inside native Pi. Outside Pi, supply it explicitly. Missing, empty, and broadcast targets are rejected. `--in` accepts positive integer seconds, minutes, hours, or days such as `30s` or `2h`. `--at` and `--deadline` require ISO timestamps with a timezone. Timers persist an absolute timestamp. The default observation deadline is one hour after the timer or one hour after admission for checks.

Each deliberate create gets a new random request ID, even for identical reminders. Supply `--request-id` before a call whose result you might lose. `wake create --request-id KEY` retrieves that admission without rescheduling. Reusing a key with different absolute arguments fails. In particular, repeating `--in` computes a different time; use the key-only retry instead. A missing retry key requires the original absolute arguments.

The `dstack_wake` Pi tool supports `create`, `list`, `status`, and `cancel`. It binds the target to its context session and scopes its retry key to the session, assistant entry, and tool-call ID. Reused provider call IDs cannot collide across sessions or turns. Creation requires a persistent native session. A create takes `trigger: { kind: "timer", at: UNIX_MILLISECONDS }` or `trigger: { kind: "github-checks", repo: "OWNER/REPO", pr: 123 }`, plus `deadline` in Unix milliseconds and `message`. The tool has a structured result schema. Its lists prioritize active wakes and return at most 64 records with an `omitted` count. The CLI lists all retained records. Do not poll the tool with model turns.

GitHub admission pins the current head. A wake becomes pending only after two observations of that head show a nonempty, fully completed check set. Completion includes failed checks and reports their count. Empty and pending checks continue waiting. A changed head ends as `superseded`. Malformed or unavailable observations remain visible in `watching.error` until recovery, deadline, or budget exhaustion. Admission fails if the head cannot be read safely. Expired observations end as `expired`; exhausted budgets or failed process cleanup end as `error`. Neither state injects a wake.

### Delivery and recovery

A pending result survives daemon restarts and has no delivery expiry. A closed or busy target leaves it pending. Resume that exact session to receive it. A fork has a different ID and cannot receive the original wake. The observation deadline does not discard an already pending result.

The receiver claims delivery durably, checks that the target is still idle, then sends one `dstack-wake` custom message with `triggerTurn: true`. It never uses the volatile busy queue. Each poll reconciles claimed deliveries before it considers pending wakes. An acknowledgement requires the matching receipt in both the native entries and the backing session file. Memory-only entries and failed file writes are not receipts. Sessions started with `--no-session` cannot create or claim durable wakes.

Reconciliation examines all branches, so moving the active branch cannot replay a delivered scheduled event. Existing coordinator and Herdr completion receipts are unchanged.

One durable claim per session excludes competing receivers. A lost acknowledgement is retried from the persisted receipt. A lost claim response, failed native send, session switch after claiming, or busy race after claiming remains `delivering` with replay blocked. Other wakes for that session cannot begin until the receipt is reconciled. There is no timeout-based claim takeover or forced reset API. Inspect the retained native session before deliberately scheduling replacement work in a new session.

Cancellation commits against canonical state and prevents injection until delivery is claimed. Once claimed or delivered, cancellation fails explicitly because it cannot retract a native turn. `delivered` proves receipt persistence, not successful model execution. This is not a general exactly-once guarantee. Local IPC clients are trusted processes running as the same user; a session ID is a routing target, not an authentication credential.

### Watch limits

- 64 active watches and 1024 retained records per daemon. Capacity errors never delete retained records or retry keys.
- Seven days maximum observation deadline from admission, 1440 observations per watch, and a default 60-second check interval.
- Two concurrent GitHub watch subprocesses, each bounded to 30 seconds and 512 KiB of output. Overload is a visible observation error.
- 4000 UTF-8 bytes per message and 1000 checks per observation.
- Only absolute timers and pinned PR checks. No arbitrary commands, process-exit triggers, shell polling, GitHub writes, or additional service.

`dstack watch`, `dstack herdr`, and passive Pi context show bounded watch summaries alongside existing jobs. Offline views retain cached state and identify it as stale. Pi context filters watches to its current session and includes receiver diagnostics without adding a persistent widget. List, status, and viewers do not deliver messages.

## Runtime and packaging

The daemon requires Linux 5.3 or newer, Node 22.19 or newer, Git, GitHub CLI, util-linux `flock`, and Python 3.9 or newer with `os.pidfd_open` and `signal.pidfd_send_signal`. The Nix package pins Node 24. The maintained `watch-pr` also needs its existing Bash and jq dependencies.

| Variable               | Default                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `DSTACK_STATE_DIR`     | `$XDG_STATE_HOME/dstack`, otherwise `~/.local/state/dstack` |
| `DSTACK_SOCKET`        | `STATE_DIR/jobs.sock`                                       |
| `DSTACK_WORKTREE_ROOT` | `~/.herdr/worktrees/dstack`                                 |
| `DSTACK_PI`            | `pi`                                                        |
| `DSTACK_GH`            | `gh`                                                        |
| `DSTACK_GIT`           | `git`                                                       |
| `DSTACK_FLOCK`         | `flock`                                                     |
| `DSTACK_PYTHON`        | `python3`                                                   |
| `DSTACK_OBSERVER`      | `~/.agents/skills/dstack/dstack-mode/scripts/watch-pr`      |
| `XDG_CONFIG_HOME`      | Existing model-policy default                               |

Executable overrides belong to trusted daemon configuration, never the public job API. `startDaemon(config)` also accepts fixed command prefixes and a remote resolver for subprocess fixtures.

The state directory must be private, canonical, and owned by the current user. The socket must be inside it. Directory and socket modes are 0700 and 0600. The API exposes no TCP listener.

`flock` locks an inherited duplicate of a file descriptor retained by the daemon. The descriptor stays open until storage closes. This lock works across network namespaces and releases after a crash. Only the daemon opens SQLite.

The Nix source must include these cross-root sources during bundling:

- `packages/dstack/`
- `config/pi/agent/lib/dstack-jobs.ts` and `dstack-watches.ts`
- `config/pi/agent/lib/model-policy.ts`
- `config/pi/agent/extensions/pi-jobs/` for type checks and extension tests.
- `config/pi/agent/extensions/pi-herdr/client.ts` and its generated protocol for Herdr navigation.

All files in `dist`, including `worker-guard.js`, belong together. The native Pi executable must remain available through the immutable wrapper or `DSTACK_PI`.

## Durable coding component

The separate [coding workspace library](docs/coding-workspaces.md) runs full Pi Durable coding conversations with private SQLite state and immutable workspace bindings. It is not wired into the PR controller or a Herdr-managed backend yet. Native extension compatibility and command-cleanup limits are documented there.

## Durable state and external effects

`pi-durable` 1.1.0 owns the PR controller's custom task and document storage. That controller creates no durable worker conversation or provider request. Waiting uses saved deadlines, ordinary timers, and bounded observations. Defaults are a 60-second observation interval, a 30-second subprocess deadline, eight worker runs, and ten minutes per worker. Observation failures back off to five minutes.

`dstack.watches` v1 and `dstack.watch` share the same Harness and `jobs.sqlite` as `dstack.jobs` v1 and `dstack.pr`. Existing PR records require no migration or backfill. No rows are removed. GitHub admission queries have a recovery scope tied to the state directory and a separate token per subprocess. Startup quiesces queries left by a previous daemon before it accepts requests.

The `dstack.jobs` document contains goals, deadlines, run receipts, review decisions, effect intents, effect receipts, and resource handles. Public snapshots include the latest ten abbreviated history entries. Full stored history and worker session files remain local.

Every effect is recorded before execution. Replies carry a stable remote marker. Recovery checks that marker, resolved-thread state, requested reviewers, and remote branch revision. An ambiguous missing receipt blocks retries. Interrupted workers are quiesced and blocked, not replayed. Native Pi file tools are not durable transactions.

Owned detached worktrees use short paths and a `dstack:JOB_ID` Git lock. Source checkout files and branches are not edited. Fetches and repair commits add objects to the source repository's shared Git object database.

Registered environment tokens identify external command scopes and workers. Recovery checks the user, process start time, and token before signaling through a pidfd. A reused PID cannot redirect the signal. Stop, merge, and closure release owned processes, verify the worktree lock release, and retain the checkout, database, sessions, and logs. No data deletion policy exists. Failed cleanup remains pending. Closure without merge is archived as `closed`.

## Review and CI behavior

The controller reuses `watch-pr --status-only` classification with the PR author's login. Conflict escalation takes priority over review threads, which take priority over CI work.

A read-only native worker verifies bot claims and human unanswered threads against code. Full thread bodies are supplied as untrusted data. Human non-author code findings receive a verdict reply immediately, then wait for the author's reaction. Thumbs up and direction allow a repair. Thumbs down leaves code unchanged. Answers can resolve questions without a code gate.

Every comment and review body the daemon posts starts with `[🫩 Daniel's Agent]` followed by a newline. The prefix marks agent-written comments so the watcher can separate them from author instructions; a pull request description never carries it. Pending human replies end with the existing exact reaction instruction. Fixed and dismissed threads get individual replies, resolution, and a re-review request. Human requests use the GitHub reviewer endpoint. Bot requests post `@LOGIN review` with the same explanation. Provider-specific bot acknowledgement is not verified.

The maintained watcher distinguishes the PR author from the authenticated publisher. It ignores agent-prefixed operational replies as author instructions. Approval binds the latest verdict to the exact discussion and full author updates. Edited or withdrawn direction cannot authorize stale work.

CI workers receive GitHub Actions failed-run logs, selected review findings, and an isolated checkout. Non-Actions checks, unavailable logs, and oversized logs block rather than dispatch a blind repair. Every selected CI failure must have supported evidence. Workers use the existing model policy's `bug-fix` role, profile, and effort. The first configured backend is exact. There is no automatic fallback. Native event output is checked for a different requested or served model.

Native workers have file tools only. Read-only triage cannot edit. Repair file tools are guarded against paths outside the checkout and Git or automation metadata. The daemon performs whitespace checks, commits, fresh PR gates, and non-force branch pushes. It does not run repository tests or retry CI jobs. Stale-base and infrastructure failures require escalation rather than a retrigger. Remote CI remains the result check.

## Pi integration

`config/pi/agent/extensions/pi-jobs/index.ts` adds `dstack_jobs` and `/jobs`. The tool returns structured state directly. `/jobs register OWNER/REPO PR observe|drive` uses the current checkout.

Background subscriptions refresh snapshots without requesting model turns. `before_agent_start` supplies relevant cached state for the current checkout and session and marks stale data explicitly. No persistent widget is installed. Session shutdown disconnects the subscription and stops that session's receiver; it does not cancel jobs or watches.

## Herdr integration

`prefix+shift+o` opens or focuses the Jobs pane. The native `prefix+o` notification shortcut stays unchanged. Concurrent opens share a private launch lock. Herdr starts the viewer through an argv layout command, not input sent to an unready shell.

The viewer verifies its ownership before reuse. Sequenced metadata expires after 15 seconds without refresh. The display preserves its header and summarizes jobs that exceed the terminal viewport. Empty, blocked, terminal, and offline states remain distinct. Closing the pane only disconnects the viewer.

`dstack herdr --notify` enables blocker and terminal notifications when it creates a new viewer. It does not change an existing viewer's notification setting. Initial attachment and stale cached snapshots do not notify.

Home Manager installs the package for Linux Pi users. `services.dstackJobs.enable = true` adds the user service. This PR does not enable the option on any host.

## Limits

This is not a security sandbox. Workers run as the current user and retain that user's environment and credentials. Tool guards reduce accidental scope violations; they do not isolate arbitrary native code, Git configuration, or hostile local processes. There is no GitHub App trigger or untrusted remote execution entry point.

Fork PRs are observe-only. Review-thread pagination ambiguity, unknown worker outcomes, missing effect receipts, stale results, unavailable models, and exhausted budgets require inspection. Monitoring remains armed for lifecycle cleanup. There is no resume or manual receipt-override API. Stop and a new explicit registration are the recovery interface after inspection.

Workers cannot run repository tests. Actual GitHub bot trigger behavior remains unverified. The generic `@LOGIN review` comment is a request, not proof that a provider accepted it.

GitHub has no atomic lifecycle-and-push transaction. A fresh read narrows but cannot eliminate the race with a concurrent merge or closure. Pushes are never forced.

The SQLite adapter uses WAL with `synchronous=NORMAL`. Process restart is covered by the intended persistence model. The latest commits can be lost on host power failure.

## Verification

Use Node 24 and the runtime prerequisites above. Run commands in a dedicated Herdr work tab.

```sh
cd packages/dstack
npm ci --ignore-scripts
npm run build
DSTACK_TEST_NODE="$(command -v node)" bun test tests ../../config/pi/agent/extensions/pi-jobs
node dist/cli.js --help
node dist/daemon.js --help
```

The acceptance suite uses the built daemon, actual SQLite, private Unix IPC, real temporary Git repositories, real subprocesses, and fake GitHub, watch-pr, and Pi subprocesses. It makes no model calls. It exercises admission, duplicate registration, exclusive ownership, disconnect, restart, offline state, human gates, branch pushes, per-thread replies, remote receipt reconciliation, interrupted-worker cleanup, conflicts, CI repair, and retained resources. Temporary artifacts remain under the printed `/tmp/dj-*` paths for inspection. The suite does not prove model judgment or GitHub's live behavior.

The watch tests exercise the actual IPC APIs, built CLI, stored jobs-v1 compatibility, daemon restart, claims, cancellation, deadlines, observation errors, session isolation, and native receipt reconstruction. Fixtures remain under `/tmp/dw-*` and `/tmp/dwr-*`.

Run the manual native proof outside the automatic suite. It uses real Pi SDK lifecycle and a deterministic custom provider, with no network model request or paid call. Node 24 must be first on `PATH`.

```sh
cd packages/dstack
npm run build
node_modules/.bin/esbuild tests/wake-proof.ts --bundle --platform=node --format=esm --packages=external --external:@earendil-works/pi-coding-agent --outfile=dist/wake-proof.js
node dist/wake-proof.js
```

The proof registers a timer through the native tool, becomes idle, restarts its isolated daemon, receives one native wake turn, and drops the first acknowledgement. Both acknowledgement attempts verify the receipt in the native JSONL file. The proof stops its receiver, proxy, and daemon, and retains `/tmp/dwp-*/proof.log` and the session file. It does not establish model judgment or live GitHub behavior.

`tests/namespace-proof.mjs` checks daemon exclusivity across real competing network namespaces. The terminal crash regression kills the daemon after the terminal document commit but before task completion. It waits for the recovered durable task to finish before checking that PR reopening caused no worker execution.

`tests/native-eval.ts` runs a separate model evaluation through the configured `bug-fix` route. The tested work profile selected `pi/openai-codex/gpt-6.1-sol:xhigh`. Native triage and repair completed in isolated repositories. Fixture tests do not establish production-model behavior.

Isolated real Herdr and Pi sessions verified Jobs pane reuse, the hotkey, stale metadata rejection, TTL expiry, narrow and wide output, offline state, and viewer disconnect. These UI checks used a private typed snapshot fixture.

Independent Sol reviews covered authority, effect recovery, process ownership, and Jobs startup. Mimo and GLM review credentials were unavailable; no routes were substituted. Full `traitor check --no-build` was blocked by an existing private flake input returning 404. Targeted package and quality checks are separate from host activation; no live configuration was applied.
