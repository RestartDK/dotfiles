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
- `config/pi/agent/lib/dstack-jobs.ts`
- `config/pi/agent/lib/model-policy.ts`
- `config/pi/agent/extensions/pi-jobs/` for type checks and extension tests.
- `config/pi/agent/extensions/pi-herdr/client.ts` and its generated protocol for Herdr navigation.

All files in `dist`, including `worker-guard.js`, belong together. The native Pi executable must remain available through the immutable wrapper or `DSTACK_PI`.

## Durable state and external effects

`pi-durable` 1.1.0 owns the custom task and document storage. No durable worker conversation or provider request is created. Waiting uses saved deadlines, ordinary timers, and bounded observations. Defaults are a 60-second observation interval, a 30-second subprocess deadline, eight worker runs, and ten minutes per worker. Observation failures back off to five minutes.

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

The passive widget uses Pi's theme, `Container`, and `TruncatedText`. It is guarded by `ctx.mode === "tui"`. A timer refreshes snapshots without requesting model turns. `before_agent_start` supplies relevant cached state for the current checkout and marks stale data explicitly. Session shutdown disconnects only the subscription.

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

`tests/namespace-proof.mjs` checks daemon exclusivity across real competing network namespaces. The terminal crash regression kills the daemon after the terminal document commit but before task completion. It waits for the recovered durable task to finish before checking that PR reopening caused no worker execution.

`tests/native-eval.ts` runs a separate model evaluation through the configured `bug-fix` route. The tested work profile selected `pi/openai-codex/gpt-6.1-sol:xhigh`. Native triage and repair completed in isolated repositories. Fixture tests do not establish production-model behavior.

Isolated real Herdr and Pi sessions verified Jobs pane reuse, the hotkey, stale metadata rejection, TTL expiry, narrow and wide output, offline state, and viewer disconnect. These UI checks used a private typed snapshot fixture.

Independent Sol reviews covered authority, effect recovery, process ownership, and Jobs startup. Mimo and GLM review credentials were unavailable; no routes were substituted. Full `traitor check --no-build` was blocked by an existing private flake input returning 404. Targeted package and quality checks are separate from host activation; no live configuration was applied.
