# Optional Herdr Durable host

This Linux-only downstream packet patches configured Herdr 0.9.5. It does not
contact upstream or enable a host. `flake.nix` routes the existing Linux `herdr`
export through this package. `modules/home/terminal/default.nix` already consumes
that export, so this is not an unused alternate package. Darwin stays upstream.
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
that keep identity fields unchanged. The package supplies
`HERDR_DURABLE_HOST_EXECUTABLE` as a default pointing to its matching `dstack-host`. An explicit override is useful for isolated
offline tests. Missing or invalid optional backends do not stop terminals.

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
not authorization. This packet exposes only the existing local trusted-user JSON
API; authenticated CLI/browser continuation and deployment authorization remain
later layers. It does not modify installed config or start a live server.

## CLI and transport

`herdr api durable '<operation-json>'` sends the optional `durable.host.v1` JSON
method. First call `{"op":"health"}`. Its operations list is empty until version,
fixed identity, frame limits, and file-only readiness match the child. Older
servers reject the missing method without affecting other operations.

Operations are `create` (`requestId`, `workspaceId`, `cwd`), `discover`, `snapshot`
(`workspaceId`), `submit` (`requestId`, `workspaceId`, `content`), and `status`
(`workspaceId`, `requestId`). `create` and `submit` require stable host-scoped
request IDs. Responses use `result.value`; receipts are official Durable records.
A caller disconnect does not cancel admitted work. There is no shell command tool.

The guardian has a 16-request queue, one in-flight RPC, a two-second RPC deadline,
a four-second pre-send expiry, and three process-start attempts per server boot.
It never resends an RPC after acknowledgement loss. Query `status` and preserve the
original request ID. Shutdown closes child stdin, waits up to ten seconds, then
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
