# Repository command environments

`repo-exec COMMAND [ARG...]` starts the configured interactive shell, calls its
`repo_env_prepare` function, and replaces the shell with the command on success.
Startup output goes to stderr. Command arguments, stdin, stdout, and exit status
are preserved. A missing preparation function or a failed hook stops the launch.
The launcher supports zsh and bash. These dotfiles supply the zsh integration.
A bash configuration must define its own `repo_env_prepare` function.

`repo-env.zsh` owns the zsh preparation contract. `repo_env_hooks` contains the
ordered function names. The default hook loads the applicable direnv environment.
The zsh configuration also registers fnm's directory hook when fnm is installed.
Other environment managers can register a function that updates the current shell
and returns a nonzero status on failure. Register environment hooks here instead
of assuming that a prompt hook runs in a noninteractive subprocess.

The first preparation reloads an applicable `.envrc` even if the shell inherited
direnv's loaded-file marker. Shell startup can otherwise overwrite exported
values while direnv still considers its environment current. Later preparations
use direnv's watched-file checks. Directories without `.envrc` work normally.
A missing direnv executable is an error when an `.envrc` or inherited direnv
state needs handling.

Pi's `shellPath` points to `repo-bash`, which runs its bash commands through the
same launcher. The interactive `pi` wrapper also uses `repo-exec` before startup.
A running Pi process does not acquire new credentials from a child shell. Restart
Pi through the wrapper after changing its credential environment.

## Herdr preparation acknowledgement

A caller creates a private directory and passes a fresh result-file path in
`PI_HERDR_READY_FILE` when creating a shell. The first prompt calls preparation,
writes its numeric exit status to that file, and unsets the variable. Zero means
prepared. Other values mean failure. The file contains no environment values.
The caller waits for the result with cancellation and a deadline, then removes
the directory. It must not submit a command on failure or timeout.

The Pi Herdr extension uses this for new tabs, workspaces, and splits. New
worktree workspaces need a prepared replacement tab because Herdr's worktree API
does not accept launch environment variables. Already-open workspaces are left
alone. Namespace selection travels in the creation request and runs before the
rest of shell initialization. Existing panes need a new shell or a restart to
load this integration.

Interactive shells remain available for repairs after a preparation failure.
Automated `herdr run` commands call `repo_env_prepare` before execution. Herdr
management operations remain available regardless of the project environment.
Commands sent to an already-running agent are not rewritten.

Preparation hooks must report their own failures. This cannot detect a shell
script that swallows a decryption error or a background evaluator that reports
success before its output exists. The direnv hook propagates reported lorri and
Nix failures without retries or an incomplete-environment fallback. Fix the
reported failure and retry. It never approves environment files automatically.

## Verification

Run the isolated launcher tests without loading real project secrets:

```sh
python3 -m unittest discover -s tests -p 'test_repo_env.py'
cd config/pi/agent/extensions/pi-herdr
npm ci --ignore-scripts
npm test
npm run typecheck
```

From the dotfiles root inside Herdr, run the live pane and Pi bash backend check:

```sh
node --experimental-strip-types tests/herdr-repo-env.ts
```

With the updated Scatterer binary built, verify the model discovery boundary:

```sh
python3 tests/scatterer-env.py /path/to/scatterer
```

The live check closes its test tabs. All checks use temporary environments and
fixture values, not real credentials.
