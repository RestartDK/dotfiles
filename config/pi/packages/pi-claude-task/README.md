# Claude Code tasks in Pi

`claude_task({ task, cwd, resume? })` runs the installed Claude Code agent through `@anthropic-ai/claude-agent-sdk`. It does not select a Claude model in Pi or change native Pi subagents.

The task needs Claude Code's own claude.ai login. API-key and cloud-provider modes fail before the SDK query starts. The child preserves `HOME` and `CLAUDE_CONFIG_DIR`, but removes inherited auth, provider, and Herdr identity variables. No Pi credentials are read.

## Task contract

- `cwd` is an absolute Git checkout path. Subdirectories resolve to the checkout root.
- Tasks run synchronously, with limits of 30 turns, $5 estimated spend, and 15 minutes.
- Shell and file mutations require one-time approval in Pi. No UI means denial. Approval expires after 60 seconds. Background shell requests and `AskUserQuestion` are denied.
- User, project, and local Claude settings are not loaded. This prevents inherited hooks, environment overrides, and allow rules from weakening the approval policy. Project `CLAUDE.md` instructions must be included in the delegated task when needed.
- Escape and session shutdown, replacement, fork, tree navigation, or reload cancel the task. Cleanup waits for the child process to close before releasing its checkout lease.
- The lease blocks another Claude task and local Pi `write`, `edit`, `bash`, and `powershell` calls, including nested tool calls. It is conservative across checkouts within one Pi process. It does not isolate unrelated processes or other agent tools.
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
