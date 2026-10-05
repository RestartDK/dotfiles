# Pi coordination

Prefer separate writable checkouts. A genuinely shared resource gets one exclusive lease for one bounded command, so agents cannot mutate the same device, checkout, or build target together. Never reserve a checkout across CI, approval waits, or a manual release FIFO. `DESIGN.md` holds the reasoning and the state layout.

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

Exit 75 means the resource is held or blocked. Print `status` and `list` before assuming a key is free. Retrying an existing attempt or watching it preserves failed and unknown outcomes. Only a settled known success exits zero.

## Use it from Pi

The `coordinate` tool submits, inspects, watches, cancels, and resolves owned attempts. `resolve` requires the attempt id and `inspected: true`; another session’s lease cannot be cancelled or resolved through the tool. Ask the owner for a bounded transfer. `/coord resolve ID` requires operator confirmation and supports inspected recovery across sessions.

A submission returns at once. A fresh unconsumed completion wakes its originating request once. Reading the settled result consumes it; watching it again does not repeat the turn. A result from an older request is recorded without waking the new task. Receipts reconstruct from the active session branch. Closing Pi still does not cancel the command or make its observer durable.

## Rules the code enforces

The same attempt id returns the existing attempt, so retry with the id rather than a fresh one. A submitted command writes its output and exit status under `attempts/`, so the next read settles it and releases the key. A holder that died without a status stays blocked until someone inspects the resource and runs `resolve --inspected`, and a command that leaves descendants behind keeps its key blocked even after it exits. Only `ESRCH` proves a process group is absent. Cancellation reconciles a recorded exit or absent group before claiming a signal was sent. Repeated reads preserve retained blocked outcomes. Inspected release marks the lease settled while its execution outcome remains unknown; it never becomes success.

## Tests

```sh
bun test test/
```

Focused process-group, cancellation, replay, and inspected-release cases use no network, model, credentials, or Pi binary. Paid and live-harness tests are out of bounds by `principle-tests-earn-their-place`.
