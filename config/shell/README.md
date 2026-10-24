# Repository command environments

`repo-exec COMMAND [ARG...]` opens the configured interactive zsh or bash,
runs `repo_env_prepare`, and executes the command in that same shell.
Exports survive preparation. Startup output goes to stderr, and startup cannot
consume the command's stdin. Arguments and command exit status are preserved.
A missing executable, missing preparation function, or failed hook stops launch.

Home Manager packages the Rust supervisor and shell integration in the Nix
store. The installed supervisor is a native executable, with `repo-bash` as an
alias that prepends the payload command `bash`. Neither entrypoint requires
Python, compiles code at runtime, or reads the authoring checkout. The public
`~/.local/bin/repo-exec` and `~/.local/bin/repo-bash` entrypoints remain available.
The executable still needs the configured shell and `ps` for group inspection.

Home Manager generates Pi's settings from `my.liveConfig.piSettingsFile`.
It defaults `shellPath` to the exact matching packaged `repo-bash` store path.
Explicit settings, including a custom `shellPath`, remain unchanged. The default
settings and their runtime dependency advance together with the Home Manager
generation. The checked-in source profiles omit `shellPath` and use Pi's native
SDK default before activation.
Profiles without the dotfiles zsh configuration must provide their own
`repo_env_prepare` function. Selecting the packaged wrapper never falls back to
an unprepared command.

## Preparation providers

`repo_env_hooks` is an ordered list of shell functions. Each function must block
until its tools and exports are usable, update the current shell, and return
nonzero on failure. The defaults run an explicitly selected provider and then
direnv. fnm's directory hook is registered when installed.

The direnv hook finds the applicable parent `.envrc`. It reloads on the first
preparation even when the source shell inherited direnv's loaded-file marker.
Direnv's own diff removes the previous project's exports. The launcher does not
use `env -i`, clear caches, or copy the source project's exported environment.
Terminal settings and credential-agent connections remain inherited.
No environment file is automatically approved.

The supported Lorri adapter runs `lorri watch --once` before evaluating direnv.
This handles a cold project cache where `lorri direnv` reports no completed
evaluation and a later `.envrc` command needs a tool from that evaluation.
Lorri is never invoked for unselected directories.

Configure trusted project paths in `~/.config/zsh/local.zsh`. Keys are zsh glob
patterns matched against the directory containing the applicable `.envrc`.
Exactly one pattern may match. The adapter uses that directory's default
`shell.nix`.

```zsh
repo_env_providers+=(
  "$HOME/src/project" lorri
  "$HOME/.herdr/worktrees/project/*" lorri
)
```

Inspect and approve each new checkout's environment with direnv before launching
work there. Selecting a provider authorizes its evaluation, not approval of the
environment file. Other managers can replace or extend `repo_env_hooks`.
Loaders that swallow failures or detach background work cannot be made reliable
by a generic launcher. Such loaders need a blocking adapter.

## Owned launches

Herdr runs and worktree handoffs use one `LaunchAttempt` receipt. Its phases are
reserved, shell startup, environment preparation, Pi or command startup, and
transfer. Environment preparation has a ten-minute budget. Pi acknowledgement
has a separate one-minute budget that starts after preparation. Generic commands
are authorized after preparation and retain their normal command-wait timeout.

The supervisor owns a private process group with an unreaped group anchor.
Interactive job control is disabled before shell startup so preparation stays in
that group. It never signals a saved PID or an unrelated pane's foreground job. Cancellation,
source loss, and deadlines stop that group before releasing ownership. Source
identity and a five-second heartbeat detect source death and stalled supervision.
The shell waits for explicit authorization before a generic payload starts.
Generic authorization and stopping compete for one no-replace decision slot,
so a stale authorization cannot commit after teardown begins.
A successor accepts the original task only through the existing owner, session,
checkout, pane, and ready-versus-stopped arbitration.

A stopped launch leaves the source usable. Uncertain ownership keeps the source
fenced until the ready-versus-stopped decision can be reconciled. Submitted
handoff reservations remain until
a retry verifies both a confirmed exit receipt and an unoccupied destination.
Unknown cleanup is reported as `recoveryRequired`; it is not permission to retry.
If the ownership lock is unavailable, the supervisor keeps the destination and
reports recovery rather than killing a possibly accepted successor. A supervision
I/O failure follows the same arbitration and preserves accepted work until it
exits. Inspect the reservation and its owner before manual recovery.

New panes preserve the selected `SHELL`, `ZDOTDIR`, and Pi agent and session
directories. They do not copy the source project's PATH or exported values.
Managed panes defer preparation to `run`, so creation itself never claims
the environment is ready. Cancellation retains the pane handle. An existing busy
pane receives no launch input. Herdr's process inspection and input submission
are separate API calls; another actor can still change a pane between them.
Cleanup only targets the supervisor's group even in that case.

Metadata-only receipts and phase timestamps are retained in private launch
directories. Export values and pane contents are not copied into diagnostics.
Provider errors remain visible in the destination terminal. Shared Nix or Lorri
daemons are not stopped. A provider must keep its owned helpers in the launch
process group; detached helpers are outside the cleanup contract. Run servers
in the foreground with `notify: true`, not with a trailing `&`.

## Development

The Rust crate lives in `packages/repo-exec`. Use its pinned development shell
without rebuilding or activating a host:

```sh
nix develop .#repo-exec
cargo run --manifest-path packages/repo-exec/Cargo.toml -- printf '%s\n' ready
cargo test --locked --manifest-path packages/repo-exec/Cargo.toml
nix run .#repo-exec -- printf '%s\n' ready
```

Running the supervisor still requires a configured interactive shell with
`repo_env_prepare`. The development shell supplies Rust tools, not environment
approval or a replacement preparation policy. The checkout's `bin/repo-*`
entrypoints run the prebuilt release executable, so build it before using those
entrypoints. Installed commands use the Nix-built executable directly.

## Verification

The isolated suite needs Rust, Python 3, zsh, direnv, and Node 22 with type
transforms. Python is only the test harness. The suite makes no model calls.
Publication-failure cases obstruct the actual receipt path rather than
monkeypatching an implementation.

```sh
cargo fmt --manifest-path packages/repo-exec/Cargo.toml -- --check
cargo clippy --locked --release --manifest-path packages/repo-exec/Cargo.toml --all-targets -- -D warnings
cargo test --locked --release --manifest-path packages/repo-exec/Cargo.toml
cargo build --locked --release --manifest-path packages/repo-exec/Cargo.toml
python3 -m unittest discover -s tests -p 'test_repo_env.py'
cd config/pi/agent/extensions/pi-herdr
npm ci --ignore-scripts
npm test
npm run typecheck
npm run check-generated
```

From this checkout inside Herdr, exercise the actual package ExtensionRunner,
real panes, namespace selection, Pi's bash backend, cancellation, and failure.

```sh
node --experimental-transform-types tests/herdr-repo-env.ts
```

The slow option exceeds the old one-minute deadline. The Lorri option requires
installed Lorri and Nix, and a nixpkgs store path. It first reproduces the cold
failure, then selects the adapter and verifies that its exported tool works.

```sh
nixpkgs=$(nix eval --impure --raw --expr '(builtins.getFlake (toString ./.)).inputs.nixpkgs.outPath')
node --experimental-transform-types tests/herdr-repo-env.ts \
  --pi-cli --slow-seconds=65 --lorri-nixpkgs="$nixpkgs"
```

The optional `--pi-cli` check loads the production factory in the npm Pi CLI and
invokes its registered tool callback with a real CLI session. It uses an isolated
agent directory with no credentials. This checks loading and tool execution,
not model selection of tools or interactive task continuation.

The proof closes its own tabs and removes its fixture environments. It does not
load real project secrets or call a model. To run checks through this revision's
Herdr tool without changing the installed extension, use a dedicated idle pane
with this checkout's launcher on PATH and its shell integration configured.

```sh
node --experimental-transform-types tests/herdr-runtime.ts PANE 'COMMAND' 600000
```

The runtime command exits with the command's recorded status and fails if Herdr
cannot confirm the return to an idle shell. Interactive task continuation and
macOS process behavior still require verification on their respective hosts.
