---
name: fleet
description: Use when Daniel asks to inspect, check, or run a command across the current computer and declared SSH aliases. Fleet selects targets and provides SSH transport. Existing dstack playbooks still own the task lifecycle.
---

# Fleet

Use `fleet` to target the current computer and SSH aliases declared by the dotfiles inventory. Do not create another host list.

Fleet owns target selection, reachability checks, and command transport. The matched dstack playbook owns planning, implementation, validation, and delivery. Use the command chosen by that playbook as Fleet's payload.

## Required sequence

1. Run `fleet list --json` and inspect the declared inventory.
2. Run `fleet check TARGET... --json` for the intended targets. Report unavailable hosts without changing Tailscale networks.
3. Run `fleet run --dry-run TARGET... --json -- COMMAND ARG...`.
4. Inspect the plan. Confirm that the resolved hosts and the exact command match the request.
5. Use `--execute` only when Daniel requested execution. Otherwise, stop after the dry-run and report the plan.

Keep the target expression unchanged between the dry-run and execution.

## Target policy

- Use `local` for the current computer.
- Use a declared alias for one named computer.
- Use `all` only when every declared remote must be reachable before any command runs.
- Use `available` when the task permits a reachable subset. Fleet still reports unavailable hosts.
- Do not replace an unavailable target with another host.
- Do not switch tailnets or weaken SSH host-key checks.

## Commands

```bash
fleet list --json
fleet check all --json --timeout 5
fleet run --dry-run all --json -- uname -a
fleet run --execute all --json -- uname -a
```

Pass each payload argument as its own shell argument. Do not build a shell string, use `eval`, or add another SSH wrapper.

## Boundaries

Use Traitor and the existing dstack playbooks for rebuilds, rollbacks, updates, tests, commits, pushes, and pull requests. Fleet only selects machines and transports the payload command. Never treat Fleet reachability as proof that the payload succeeded.
