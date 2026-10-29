# Optional Herdr Durable host

This downstream packet patches configured Herdr 0.9.5. Each configured platform
uses the same API declaration so generated client types do not depend on the
build platform. Only the Linux export packages the matching `dstack-host` backend
and supplies its default executable. Darwin builds the patched API but has no
packaged backend or runtime qualification. Nothing contacts upstream or enables
a host. `modules/home/terminal/default.nix` consumes the existing `herdr` export.
The package asserts version 0.9.5; an input update needs a fresh source review.

The base is `/nix/store/m46g1ic5khx688hfy0mlhcsm7hg1vzs4-source`, not the user's
running 0.9.1. `host.patch` is an a/b patch against that source. It adds a dedicated
`server::durable_host` module owned by `HeadlessServer`. No process handles enter
`AppState`. No plugin startup hook or frozen wire codec changes are involved.
The changed generated API schema is additive JSON, not a generation-1 fixture.

## Configuration

The host is disabled unless the **server process** has `HERDR_DURABLE_HOST_CONFIG`
set to an absolute JSON file path. This is a boot-time setting, not reloadable
configuration. The guardian pins the exact configuration bytes with SHA-256 for
its lifetime. Each child verifies that digest before constructing model runtime or
opening stores. Any file edit requires an ordinary server restart, including edits
that keep identity fields unchanged. On Linux, the package supplies
`HERDR_DURABLE_HOST_EXECUTABLE` as a default pointing to its matching `dstack-host`.
An explicit override is useful for isolated offline tests. Missing or invalid optional backends do not stop terminals.

Example configuration, with paths chosen for the deployment rather than supplied
by RPC callers:

```json
{
  "identity": {
    "deploymentId": "work-local-01",
    "domain": "work",
    "nodeId": "work-node-01"
  },
  "stateRoot": "/absolute/private/work-host",
  "model": { "provider": "configured-provider", "modelId": "configured-model" },
  "thinkingLevel": "xhigh",
  "authPath": "/absolute/work-profile/auth.json",
  "modelsPath": "/absolute/work-profile/models.json"
}
```

Model and thinking level initialize new conversations only. Reopening retains the
persisted agent settings. Choose an effort supported by the selected model; there
is no automatic role-policy lookup or fallback in this packet.

Use a different root and fixed identity for personal deployment. Root and database
permissions must be private and user-owned. Billing/model profile selection is
not authorization. The Native JSON API remains trusted same-user control.
Authenticated CLI/browser clients and the default-disabled Home Manager registry
are described in [Independent deployments](../dstack/docs/deployments.md).
The example above is the legacy file-only mode. Managed authenticated deployments
use a new private root and the stricter deployment contract. Nothing here modifies
installed config or starts a live server.

## CLI and transport

`herdr api durable '<operation-json>'` selects `durable.host.v1` for workspace
operations and the separate `durable.commands.v1` for `command.*`,
`execution.status`, and `file.reconcile`. The published workspace operation enum
has not changed. First call `{"op":"health"}`. Its operations list is empty until
the child's version, identity, frame limits, and file-tool registrations match.
Older servers reject a missing method without affecting other operations.

Workspace operations are `create` with `requestId`, `workspaceId`, and `cwd`,
`discover`, `snapshot` with `workspaceId`, `submit` with `requestId`, `workspaceId`,
and `content`, and `status` with `workspaceId` and `requestId`. Request IDs are
stable and host-scoped. Responses use `result.value`; submission receipts are
official Durable records. Disconnect detaches without cancelling admitted work.

### Managed execution control

Managed execution is opt-in through `"execution":{"mode":"durable","maxRecords":16384}`
in the host config. Use a new private state root. Adding this setting does not
upgrade an existing legacy workspace. The host pairs its catalogue, execution
journals, and actual SDK documents before allowing workspace progress. Missing,
partial, disabled, or inconsistent ownership evidence refuses reopening and stays
on disk. The host prepares every managed workspace before activating any Harness;
a partial command authorization or orphan directory in one workspace therefore
refuses the whole host, not just that workspace. Preserve all paired evidence.
There is no supported quarantine-rename recovery, automatic repair, or deletion.

`{"op":"command.health"}` reports the separate method and advertised operations.
Managed file-only hosts advertise `execution.status` and `file.reconcile`; a
configured command runtime also advertises `command.authorize`, `command.start`,
`command.status`, `command.inspect`, `command.adopt`, `command.cancel`,
`command.release`, and `command.reconcile`. Legacy hosts advertise none of these.
Model tools remain `read`, `write`, and `edit`. No model shell or command tool is
registered.

A trusted local caller authorizes an immutable intent, then starts that intent:

```sh
herdr api durable '{"op":"command.authorize","workspaceId":"coding","intentId":"build-17","spec":{"argv":["/absolute/bin/tool","arg"],"timeoutSeconds":60}}'
herdr api durable '{"op":"command.start","workspaceId":"coding","intentId":"build-17"}'
herdr api durable '{"op":"command.inspect","workspaceId":"coding","intentId":"build-17"}'
```

Only authorization accepts argv and timeout. The executable must be absolute.
There are 1 to 128 arguments, at most 4096 UTF-8 bytes each and 16384 bytes total.
Timeout is an integer from 1 to 3600 seconds. The owner binds cwd, environment,
credentials, boot/capture identity, and live filesystem descriptors. Callers cannot
supply those fields or a reconciliation actor. Reusing an intent with changed
content refuses; repeated starts attach without launching another attempt.

`execution.status` returns the root ID, journal sequence, unresolved effect IDs,
and up to 32 command/file phase summaries in effect-creation order. It does not
expose the root token. `file.reconcile` accepts `workspaceId`, an observed
`effectId`, and an operator `reference`; it works without a command runtime.
Reconciliation records the local audit label `herdr-local-user`, not authentication.
It acknowledges uncertainty without inventing an exit or proving empty containment.
Command adoption and namespace release require their separate original evidence.

This is trusted same-user control, not authenticated browser ingress or an OS
sandbox. Identity strings must be well-formed Unicode; paths are NUL-free and at
most 4095 UTF-8 bytes. Older invalid pending admissions are retained and refused,
not rewritten or silently migrated. Valid padded identities and U+0085 remain
unchanged. A failed command lookup or missing manager does not prove non-execution.

The guardian has a 16-request queue, one in-flight RPC, and three process-start
attempts per server lifetime. Workspace RPCs retain their two-second budget and
four-second request expiry. Command controls have a 60-second RPC budget and
62-second expiry to cover bounded capture, manager inspection, and original
custody release. Expiry starts at enqueue: expired queued requests are not sent,
and each exchange is limited by both its RPC budget and remaining expiry. These
control budgets do not change a command's approved payload timeout. A successful
exchange does not reset the process-start budget.

The ready frame's `bootId` identifies the Node process instance, not the kernel
boot. Command evidence carries its separate actual kernel/source boot identity.
The guardian never resends an RPC after acknowledgement loss. Query `status` and
preserve the original request ID. Shutdown closes child stdin, waits up to ten seconds, then
kills and reaps an unresponsive child. Forced shutdown is a crash, not proof that
an ambiguous effect did not happen. Restart reconciles the durable admission journal.

Live handoff is refused while the host is enabled, including when unavailable.
The refusal precedes client detach and PTY/fd mutation. Use ordinary shutdown and
restart. Disabled behavior remains unchanged. PR/wake daemons and their stores
remain separate; this packet does not migrate or duplicate their publishers.

## Offline proof

Build `packages/dstack` first. Run with Node 24:

```sh
HERDR_TEST_BINARY=/absolute/matching/herdr \
  node packages/herdr-durable/tests/host-e2e.mjs
```

This starts isolated Herdr servers with their own HOME, XDG directories, config,
and sockets. It uses a real Node Durable host with a faux provider, exercises the
actual CLI, proves file/receipt recovery, and checks handoff refusal and optional
backend failure. It stops its servers and preserves evidence directories.
It does not establish production-model behavior or full six-layer acceptance.

`tests/clients-e2e.mjs` exercises the production Host entrypoint with two real
Rust-managed instances, private deployment-mode config and a shared HOME with
separate XDG namespaces. Set `HERDR_TEST_BINARY` and `DSTACK_TEST_PACKAGE` to the
matching Herdr and dstack outputs, plus the pinned runtime references listed below.
It proves authenticated audience/principal/workspace isolation while an actual
SDK-owned business command is active. SDK abort and original-pidfd CLI SIGINT
must leave that command active; explicit authenticated cancellation must produce
the original receipt and independently empty containment before adoption/release.
The model endpoint is a task-private trap and must receive zero requests. The
proof joins its original owners and preserves evidence. Uncertain cleanup retains
custody instead of stopping owners or inventing a result.

Set `HERDR_TEST_COMMANDS=1` and supply the pinned `DSTACK_COMMAND_HELPER`,
`DSTACK_SYSTEMD_RUN`, `DSTACK_SYSTEMCTL`, and `DSTACK_BUSCTL` references to include
the Native command lifecycle. Point `DSTACK_TEST_FIXTURE` at the matching package's
`dist/tests/host-fixture.js`. This proof keeps the original user-manager bus and
runtime directory while isolating its API/client sockets. It checks authorization,
one actual SDK-owned attempt, bound receipt adoption, original empty containment,
and FD-store release. It also checks correlated invalid requests and unchanged
model tools. A passing lifecycle is not all failure-window acceptance.

To include real manager-launch latency, build the opt-in test tool with
`nix build .#herdr.testTools.delayedSystemdRun --no-link --print-out-paths` and set
`DSTACK_SYSTEMD_RUN` to that executable for the same Native proof. It delays the
real `systemd-run` by 2.75 seconds; it does not fabricate manager responses or
command evidence. The proof waits for an actual attempted/activated phase, then
requires inspection to finish without replacing the Node instance, followed by
bound receipt adoption and original custody release. The normal workspace
stall/restart-budget cases run unchanged. This tool is not a production launcher
or part of generic CI, and the proof preserves the original user-manager bus.

Set `HERDR_TEST_OWNERS_ABSENT=1` with `HERDR_TEST_COMMANDS=1` for the separate
both-owner-absence case. The payload waits for a trusted marker. The proof stops
the actual Rust server, awaits its exit and verifies Node has exited, then writes
the marker. It reads a bound successful receipt before restarting either owner.
Ordinary restart must adopt that receipt and release original empty custody
without another attempt. This tests completion during owner absence after an
ordinary stop, not an injected Rust SIGKILL. Failure preserves uncertain evidence.
