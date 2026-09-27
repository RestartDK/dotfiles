# Pi coordination

Status: implemented in `core.ts`, `cli.ts`, `index.ts`, and `test/lease.test.ts`. The archived broker stays the reference for the semantics below, and its server design is superseded.

## Goal

Several agents run at once. They share a physical e-reader, repo checkouts, and build target directories. Two agents touching one of those at the same time corrupts flash or a checkout. Coordination has to be mechanical, because an agent that forgets a rule runs the command anyway.

## Shape

- One lease per resource key. A lease is a directory, created atomically.
- No daemon, no socket, no server. Any process can take a lease with a directory create, including a shell script and a Herdr pane.
- No Nix package and no store artifact. The Pi extension is the runtime, and a three-line shim execs its `cli.ts` from the live extension directory, so the shell and the extension never drift.
- Enforcement lives in the consuming repo's wrapper, not in prose. The wrapper takes the key itself, so an agent cannot forget it by choice.

## Seam

The general layer knows keys, attempts, process groups, and records. It must not contain the words brewthink or x4. The repo layer declares key values and wires its own wrappers to the general entry point.

## State

Root is `$XDG_STATE_HOME/pi-coordination`, defaulting to `~/.local/state/pi-coordination`, overridable with `PI_COORD_DIR`.

| Path | Contents |
| --- | --- |
| `leases/<key>/holder` | attempt id, owner, revision, start time, format version, client pid, and the pgid written by the command's wrapper |
| `attempts/<id>.json` | outcome, exit code, duration, revision |
| `attempts/<id>.log` | full output, written by the command's wrapper |
| `attempts/<id>.status` | exit status, written by the wrapper just before it exits |

The existing `jobs.sqlite` holds 214 attempts. Archive that directory before the first run of this layout, and never retry an old ID in a new history.

## Keys

`device:x4`, `worktree:<abs path>`, `target:<abs path>`, `repo:<name>:<branch>`. State is machine-global, because the device and the CPU are machine-global, and two checkouts of one repo contend for the same key.

## Semantics carried over

- The same ID after an uncertain submission returns the existing attempt. A fresh ID can execute twice.
- Only `ESRCH` proves a process group is absent. A group that cannot be confirmed absent keeps the key blocked until someone runs resolve and asserts they inspected it.
- A holder that died without recording an exit status stays blocked and is never re-run. A holder that finished and recorded one settles on the next read, so a clean completion releases the key by itself.
- A dead client does not free the key.

## Tests

Six assertions under `bun test`, with no model, no credentials, no network, and no Pi binary.

1. Two takers, one wins, disjoint keys progress.
2. The same ID returns the existing attempt.
3. A detached command records its exit status and releases the key.
4. A dead client does not free the key.
5. A restart never replays.
6. A surviving descendant keeps the key blocked.
7. A corrupt or unknown-version record refuses to run and never reads as free.

`principle-tests-earn-their-place` forbids any test that spends money, needs credentials, or spawns a real agent CLI, including behind an env-var hatch. Tool selection by a model is checked by hand and recorded in the PR.

## Superseded

`~/.local/state/worktree-archive-2026-09-22/patches/.herdr_worktrees_dotfiles_daniel-pi-coordination.patch` is the reference implementation. Keep it for the six semantics above and for the Sep 20 process-group hotfix. Do not resume the socket, the SQLite schema, the `serve` process, or the CLI package.
