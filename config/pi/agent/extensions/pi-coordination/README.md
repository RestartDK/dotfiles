# Pi coordination

One exclusive lease per shared resource, so several agents can work on this machine without two of them touching the same e-reader, checkout, or build target. `DESIGN.md` holds the reasoning and the state layout.

There is no daemon. A lease is a directory under `~/.local/state/pi-coordination`, taken with an atomic create, and every reader sees the same files.

## Use it from a wrapper

A repo that owns a shared resource takes the lease itself, so an agent cannot forget it by choice.

```sh
#!/bin/sh
exec bun "$HOME/.pi/agent/extensions/pi-coordination/cli.ts" \
  exec --resource device:x4 --label "device control: $*" -- "$@"
```

`exec` waits for its turn, runs the command in its own process group, records the outcome, and releases the key. `submit` does the same without waiting.

```text
pi-coordinator [--dir PATH] COMMAND [OPTIONS] [-- PROGRAM ARGS...]

  exec --resource KEY [--label TEXT] [--id ID] [--owner OWNER] [--revision REF]
       [--cwd PATH] [--wait MS] -- PROGRAM ARGS...
  submit   Same options as exec, without waiting for the command
  watch --id ID [--wait MS]
  status [--id ID] [--limit N]
  list
  cancel --id ID
  resolve --id ID --inspected
  state
```

Exit 75 means the resource is held or blocked. Print `status` and `list` before assuming a key is free.

## Use it from Pi

The `coordinate` tool takes, watches, and cancels leases, and `/coord` shows held resources, reconnects a watch, and resolves an inspected block. A submission returns at once and a completion message arrives later, so a session is not blocked while another agent holds the key.

## Rules the code enforces

The same attempt id returns the existing attempt, so retry with the id rather than a fresh one. A submitted command writes its output and exit status under `attempts/`, so the next read settles it and releases the key. A holder that died without a status stays blocked until someone inspects the resource and runs `resolve --inspected`, and a command that leaves descendants behind keeps its key blocked even after it exits. Only `ESRCH` proves a process group is absent.

## Tests

```sh
bun test test/lease.test.ts
```

Six assertions, no network, no model, no credentials, and no Pi binary. Paid and live-harness tests are out of bounds by `principle-tests-earn-their-place`.
