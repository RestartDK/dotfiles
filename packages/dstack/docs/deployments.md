# Independent Herdr Durable deployments

Each deployment has one Rust Herdr server, one managed Node backend, and local
SQLite owners. Work can run on Titan while personal runs on Nana or Hatchi.
Neither needs the other machine online. There is no shared live database,
connectivity takeover, coordinator, or separate authentication daemon.

```text
Home Manager instance
  └─ herdr server                         Rust lifecycle and trusted Unix API
       └─ dstack-host                     Node DurableHost
            ├─ authenticated loopback HTTP, CLI and browser
            ├─ one official Harness per coding workspace
            │    ├─ official Registry and conversation/task records
            │    └─ local SQLite under exclusive ownership
            └─ command capability
                 ├─ immutable approved intent and actual SDK task
                 ├─ original captured descriptors and independent custody
                 └─ local user-manager helper, receipt and containment evidence

Existing dstackd PR jobs and wakes keep their own Unix socket, database and
publisher authority. They are not an authentication gateway for these clients.
```

## Deployment registry

`services.herdrDurable.deployments` defaults to `{}`. That creates no Herdr
Durable service. Registry membership declares a Linux instance. It does not
follow `my.ai.profile`, which selects billing and model policy only.

For example, a future personal host configuration can declare:

```nix
services.herdrDurable.deployments.personal = { };
```

This declares `herdr-durable-personal.service`. The default private Host JSON is
`${config.xdg.configHome}/herdr-durable/personal/host.json`. An entry may set
`hostConfigFile` to another file inside that protected deployment config root.
Names contain 1 to 24 lowercase letters, digits or hyphens, with an alphanumeric
first character. At most 16 instances are allowed. Config references must be
distinct, absolute, traversal-free runtime paths, not Nix store paths.

The module never writes Host JSON, credentials, or credential contents into the
Nix store. Provision the private files deliberately. Building or evaluating the
module does not install or start a service.

The private JSON remains the sole authority for:

- The complete `{deploymentId, domain, nodeId}` identity.
- Local `stateRoot`, model, thinking level, authentication and model-config refs.
- Durable execution and the authenticated workspace roster.
- Each credential reference, principal and exact workspace permissions.
- A fixed nonzero `127.0.0.1` client port.

Use the closed `HostConfig` codec in `src/host-protocol.ts` and client config in
`src/client-authority.ts`. Paths in JSON are literal absolute paths. They do not
expand shell variables. Choose a separate local state root inside the protected
Herdr Durable state tree for each identity. A second owner of the same store
refuses, even if its service label or model profile differs.

The service sets `DSTACK_HOST_MODE=deployment`. Before constructing model runtime
or opening stores, the backend requires a nonroot-owned, single-link regular
config file with exactly mode `0400` or `0600`. It does not follow the final
symlink or accept special mode bits. Deployment mode also requires authenticated
durable execution, a fixed loopback port, and protected config, state, auth,
model and token references.

Each instance gets separate API/client sockets and XDG config, state and cache
directories. Herdr itself reads `XDG_STATE_HOME`, so separating sockets alone is
insufficient. The service preserves the original user-manager bus and
`XDG_RUNTIME_DIR` for command capture. It uses the packaged backend, not an
inherited executable override. Restart is disabled. An operator chooses when to
restart an instance.

## Clients and authority

Native workspace and command control keep `durable.host.v1` and
`durable.commands.v1`. The Native one-reply exchange is not a progress stream.
Authenticated clients use the separate versioned Node HTTP contract.

A credential binds the complete deployment audience, one principal, and explicit
workspace permissions. A caller's profile, actor label, cwd or guessed intent ID
grants nothing. HTTP clients cannot authorize a command, choose argv, provide
capture descriptors, or reconcile an effect. They can request business
cancellation only for an already-authorized intent in their permitted workspace.

`dstack-client --help` lists the closed CLI commands. `submit` reads UTF8 content
from stdin. Credentials come from a private file, not an argument or URL. Keep a
logical request key after a lost acknowledgment and query `status` before a
manual retry. Open and submit use different request namespaces. Restart and key
rotation do not change the logical request identity.

The served browser uses native file selection, clears the selected input, and
keeps its credential in tab memory. It does not use cookies or browser storage.
Forget invalidates pending file reads as well as active requests. Only initial
setup or New Request chooses a new logical request key.

For remote access, forward the same loopback port through SSH, for example
`ssh -N -L 47131:127.0.0.1:47131 HOST`. The Host and Origin checks require the
configured port. There is no public plaintext listener, wildcard CORS, proxy
identity, query token or embedded HTML bearer. Neither the service nor browser
copies credentials between machines.

Observation uses the public SDK committed event stream. Initial and overflow
snapshots are atomic and have no sequence number. Reconnect acquires a fresh
snapshot without submitting or resuming a turn. History pages use the original
SDK cursor behind a finite, scoped opaque token. Frame, display, connection,
watch and writer limits can retire a viewer without cancelling work. Those
limits do not bound the SDK's internal transcript acquisition.

## Command capability and recovery

`hostCommandCapability` packages `herdr.command.consume` version 1 and its
`herdr.command-owner` extension. The Host installs that extension in the existing
official Registry and schedules the same task object. There is no second
Harness, scheduler, database writer or capability daemon. The model's tools
remain `read`, `write` and `edit`.

A trusted Native caller authorizes an immutable intent. The task consumes its
intent ID, records the actual SDK conversation/task identity, and asks the same
execution owner to start it. The caller cannot replace approval, argv or capture
authority at the task boundary. File mutations still pass through the native
mutation gate and sequential execution.

Closing a viewer, CLI SIGINT and SDK abort are not business cancellation. The
separate `command.cancel` operation records an explicit cancellation request.
Outcome and containment remain separate facts. Adoption needs the matching
original receipt and independently proven original empty containment. A missing
helper, manager or receipt does not prove success or nonexecution.

Recovery keeps unresolved effects paused. It does not replay them, fabricate an
exit, or signal a checked numeric PID or reusable unit name. Cleanup failures
retain uncertainty and original custody. Preserve partial stores and paired
catalogue, journal, receipt and SDK evidence. There is no automatic repair,
quarantine, schema rewrite or takeover.

## Protected state and format compatibility

Production durable Hosts protect PR/wake state, model policy, agent auth,
GitHub/SSH/Git control files, deployment config/state trees, token refs and
explicit extra control roots before activating a Harness. The Home Manager
module also protects configured provider-key directories. Broad workspace
selection does not make those files model-readable or writable. File aliases
and protected-parent checks remain part of the file adapter.

Every production entrypoint with durable execution uses Host binding format 4,
including Native-only hosts without `DSTACK_HOST_MODE`. Format 4 pins the exact
canonical protection policy, identity, canonical root and client mode (`native`
or `authenticated`). Removing or adding clients to an existing store, omitting
the policy or retargeting it refuses reopening. Named deployment mode adds the
private-file, authenticated fixed-port and protected-reference requirements. A
real older clients3 owner refuses that store before Harness activation. The
catalogue, journal, SDK and wire formats keep their own existing versions.
Legacy library formats 1, 2 and 3 remain supported without a production policy.
They do not upgrade themselves into format 4.

Adding a second deployment does not alter an existing instance's protection
policy. Both already deny access to the shared deployment config/state parents.
Credential files rotate within those protected roots; one Node lifetime has one
credential epoch. Ordinary restart loads the next epoch. There is no SIGHUP
reload, mtime authority or automatic credential migration.

These rules protect supported file-tool access and detect inconsistent paired
evidence. They are not an adversarial same-UID syscall sandbox or proof against
coherent restoration of all paired stores. Linux command execution is qualified
as `trusted-user-mapped-fs`, not arbitrary mapped-source credential isolation.
Darwin/Windows execution, public ingress, separate-host failover and deployment
activation need their own acceptance evidence.
