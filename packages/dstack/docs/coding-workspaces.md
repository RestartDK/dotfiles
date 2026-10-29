# Durable coding workspaces

`CodingWorkspaceOwner` runs an official Pi Durable coding conversation with local SQLite. It is a library component. It does not start a service, expose a network API, replace native Pi, or migrate existing PR jobs and wakes.

## Ownership and storage

An owner binds one private store to `domain`, `nodeId`, `workspaceId`, and a canonical `cwd`. The binding is committed before the root conversation can run. A reopen must match every field. A symlink to the same canonical cwd is the same binding.

`conversation.sqlite` holds the conversation, submissions, tool results, and interrupted-task state. `conversation.lock` excludes concurrent processes across network namespaces. Directories containing `jobs.sqlite` are rejected. Existing PR and wake storage is unchanged. There is no migration, backfill, or row deletion.

The caller supplies a `Models` catalog and an initial `ModelRef`. Optional `initialThinkingLevel` sets the reasoning level in the same creating commit, before resume. Omitting it keeps the SDK default. A reopen retains the stored agent choices, including thinking level, and requires their model in that catalog. Credentials are not stored in the workspace binding. The caller owns model policy and credential selection.

The owner installs official `CodingTools` and uses `NodeExecutionEnv`. The caller must select `execution: "trusted-user"`. Immutable cwd prevents accidental retargeting, not file access outside the worktree. File tools and arbitrary commands still run as the Unix user. This is not a sandbox or a security boundary between work and personal code.

Closing the owner suspends its Harness and releases storage and execution resources. Client detach is a separate concern for the later host adapter. The official conversation and submission handles remain the API; this component adds no scheduler or conversation engine.

## Recovery contract

Completed submissions can be retrieved by their original request ID after reopening. Pi Durable 1.1.0 deduplicates by conversation, request ID, and submission type. It does not compare changed input content under an existing key. An external command API must enforce its own payload-conflict contract before calling this library.

An interrupted generation resumes from its committed task checkpoint. An interrupted unsafe bash tool produces an `interrupted` diagnostic instead of running the command again. That diagnostic does not establish whether an external effect completed. The host must reconcile unknown outcomes rather than blindly retry them.

The subprocess proof explicitly kills its isolated stopped tool group before recovery. It proves non-replay, not automatic cleanup of arbitrary commands after owner death. Stable long-command ownership belongs in the execution adapter.

SQLite uses WAL with `synchronous=NORMAL`. Process-crash recovery does not prove power-loss durability, backup restoration, filesystem replication, or automatic takeover.

## Native Pi compatibility

| Native capability | This component |
| --- | --- |
| Read, write, edit, and bash | Official Durable tools, verified with actual file and process effects. |
| Conversation, submissions, and model-request identity | Official Harness storage and handles, verified across process restart. |
| Native JSONL sessions | Not imported or converted. Durable stores are separate. |
| Global and repository instructions, skills, and prompt templates | Not loaded automatically. A host must render an explicit agent profile. |
| Native Pi extensions and lifecycle hooks | Not loaded automatically. Durable has its own extension registry. |
| Native subagent and Herdr tools | Not installed. They need explicit Durable adapters. |
| Existing PR jobs and session-targeted wakes | Unchanged in the existing controller and native extension. |
| Billing profile | Caller-owned. The manual live proof uses the exact configured `precise-code` route. |

## Run the proofs

Use the package's Node prerequisite. The Nix package supplies Node 24. No live service or database is needed.

```sh
cd packages/dstack
npm ci --ignore-scripts
npm run build
DSTACK_TEST_NODE="$(command -v node)" bun test tests/conversation.test.ts
```

The proofs import the shipped `dist/conversation.js` through `#coding-workspace`; they do not embed a separate copy of the owner. The automatic proofs use an offline provider and real tools, SQLite, Git directories, locks, and subprocesses. They test completed-result deduplication, binding mismatch, concurrent ownership, committed-generation recovery, unsafe-tool non-replay, checkpoint-close failure cleanup, and reopening after model changes. They retain `/tmp/dstack-conversation-*/proof.json` and restart `fixture.log` files.

The separate live proof makes real model requests through the configured profile. It uses `ModelRuntime` 1.1.0 for authentication, matched to Durable and pi-ai 1.1.0, without a fallback model. The 0.99.1 SDK has a separate nominal transcript type and cannot supply this `Models` interface. The development SDK update does not replace the installed native Pi executable or load its extensions into Durable. Its agent-core, codemode, and MCP dependencies are pinned to 1.1.0 too. Resolving their broad ranges to 1.4.0 caused a missing-export failure before any model call. It offers only read and write tools. It starts two separate owner processes, verifies real file results and persisted context, and checks the same provider-session identity after restart.

```sh
node dist/tests/conversation-live.js
```

Each phase has a 150-second API deadline and a 180-second process deadline. The proof retains `/tmp/dstack-conversation-live-*` with the isolated database, worktree, identity, and phase reports. It does not activate Home Manager, change the running Herdr binary, or open a listener.
