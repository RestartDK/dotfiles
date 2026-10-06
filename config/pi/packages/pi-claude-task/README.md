# Claude Code tasks in Pi

`claude_task({ task, cwd, resume? })` runs the installed Claude Code agent through `@anthropic-ai/claude-agent-sdk`. It does not select a Claude model in Pi or change native Pi subagents.

The task needs Claude Code's own claude.ai login. API-key and cloud-provider modes fail before the SDK query starts. The child preserves `HOME` and `CLAUDE_CONFIG_DIR`, but removes inherited auth, provider, and Herdr identity variables. No Pi credentials are read.

Claude's [SDK/headless credits](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) are separate from its interactive allowance. Login alone does not prove credits are available. This package neither opts in to credits nor enables paid extra usage.

## Task contract

- `cwd` is an absolute Git checkout path. Subdirectories resolve to the checkout root.
- Tasks run synchronously, with limits of 30 turns, $5 estimated spend, and 15 minutes per invocation. A resumed invocation gets fresh limits; usage accounting remains cumulative.
- Shell and file mutations require one-time approval in Pi. No UI means denial. Approval expires after 60 seconds. Background shell requests and `AskUserQuestion` are denied.
- User, project, and local Claude settings are not loaded. This prevents inherited hooks, environment overrides, and allow rules from weakening the approval policy. Project `CLAUDE.md` instructions must be included in the delegated task when needed.
- Escape and session shutdown, replacement, fork, tree navigation, or reload cancel the task. Cleanup waits for the child process to close before releasing its checkout lease.
- The lease blocks another Claude task and Pi tools not annotated read-only, including nested calls. The trusted `codemode` dispatcher remains available; its nested writers are checked separately. Default local user-shell commands hold a lease until they finish, fail, or cancel. The guard registers after existing shell handlers, so it does not replace custom shell backends. It is conservative across checkouts within one Pi process, not isolation from other processes or custom shell backends.
- Resume accepts only an SDK-issued session id recorded on the active Pi transcript branch for the same canonical checkout. Branch changes restore these bindings from Pi entries.
- Terminal results distinguish success, cancellation, budget exhaustion, turn exhaustion, and execution or protocol errors. Progress and final text are capped. Final usage is reported once, subtracting stored cumulative usage on resume.

## Deployment

Nix builds `packages.pi-claude-task` from this directory and deploys it under `~/.pi/agent/packages/pi-claude-task` for both Pi profiles. The package is outside the recursively linked extensions directory and is not part of the published npm package updater.

## Verification

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests use SDK-typed fixtures, temporary Git repositories, and disposable Node processes. They do not run Claude or contact a provider. Live provider verification requires a separate Claude login and an explicitly approved task.
