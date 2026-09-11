# Migration validation ledger

The migration starts at `c6de1f6ee713be8bc2b73b047e245ca2a7d08e16` on `daniel/nixos-srv-hatchi`. GPT-6 Astra with xhigh reasoning owns this completion pass without subagents. The canonical checkout and live hosts remain untouched.

## Current result

The review corrections pass local policy tests, the real VM-only CLI rejection, formatting, actionlint, Darwin `traitor check`, and all-system evaluation. Both evaluated inline test-driver strings parse. The pinned deploy-rs schema accepts both node definitions. All existing root input pins and existing host/module files remain unchanged.

Linux closures, deploy-activate, the activation refusal executable, installed VM boot, and the production service VM remain NOT VERIFIED. The new restart, network, and credential-rotation assertions have not run on Linux. The branch is not ready for cutover.

The controller is ARM Darwin. Nix reports `builders = @/etc/nix/machines`, but that file does not exist. No safe configured x86 Linux/KVM executor is available. OrbStack's known amd64 emulation failure was not repeated. No Linux VM command or live-host access was attempted in this correction pass.

## Command evidence

[commands.tsv](commands.tsv) records exact command strings, exits, and log pointers. `astra-` rows are reruns by the current owner. Every local check in the table below was rerun successfully except the standalone schema validator, whose integrated Linux build is still pending. `fixes-` and earlier rows are inherited historical records. Their temporary paths are not durable review proof. Earlier Python checks do not verify the replacement code.

| Check | Exit | Meaning |
| --- | --- | --- |
| `./bin/traitor verify srv-hatchi policy` | 0 | Exact-node parsing, zero-argument VM wrapper, receipt shape, strict credential parsing, atomic merge retention and rotation, pinned source inventory, generated ACME dependencies, and static safety assertions pass. |
| `nix run .#srv-hatchi-install-vm -- --store-paths /nix/store/refused /nix/store/refused` | 2 | Expected rejection by the real packaged entrypoint. The ledger wrapper exits 0 after checking this result. |
| `./bin/traitor deploy srv-hatchi --dry-run` | 1 | Expected uncommissioned rejection before deploy-rs. |
| `traitor check --print-build-logs` | 0 | Darwin formatting and policy checks pass. Linux builds are omitted by platform. |
| `traitor check --all-systems --no-build --print-build-logs` | 0 | All named host, app, package, formatter, and check outputs evaluate. No Linux build or activation ran. |
| Pinned `check-jsonschema` against `.deploy` | 0 | Both deploy node definitions match the upstream schema. |
| Evaluated `config.testScriptString` syntax checks | 0 | Both complete inline drivers parse. This is not runtime proof. |
| Pinned `actionlint` | 0 | CI syntax and shell checks pass. |
| Existing root input pin and host/module comparison | 0 | No unrelated host or existing pin changes. |
| Python-file check | 0 | No `.py` path in the task diff or either Hachi directory. Repository-wide `find` reports only pre-existing, unchanged Python elsewhere. |

Raw Nix was used for targeted output evaluation, formatting, the real app rejection, and upstream schema and lint tools. `traitor` has no equivalent diagnostic. New CLI paths use `./bin/traitor` because the PATH binary belongs to the untouched canonical checkout. `traitor check` resolves this worktree from the current directory.

The inherited code manifest digest was `ba2cd55350cd04f3c4a606b2c4bf31dfad98bc437a1a6aaaa4dbe2c3ebebc7c5`. Hosted evidence will record the checked commit SHA and lock digest. Audit documents are not treated as proof of an unchanged code revision.

## Failures retained in the ledger

- `fixes-policy-first` caught non-idempotent INI line placement. The merger now preserves owned keys in place and emits missing sections without repeated blank lines.
- `fixes-policy-second` caught a failed first operand in a shell `&&` expression that did not abort. Credential lengths now have an explicit rejecting branch.
- `fixes-format-first` caught two `inherit` style issues and missing shell metadata. These were corrected without suppressions.
- `fixes-actionlint` caught an ambiguous sudo redirection. Journal capture now uses a pipe to the runner-owned evidence file.
- `fixes-inline-drivers` tried to coerce Disko's function-valued `testScript` into a string. The corrected diagnostic uses upstream `testScriptString` and passes.

No failed command is counted as a pass. See [accepted findings](review.md) for the complete correction mapping.

## Required Linux commands

Run these on x86 Linux with KVM. They do not contact either live host.

```sh
./bin/traitor check --all-systems --no-build --print-build-logs
./bin/traitor verify srv-hatchi closures
nix build --no-link --print-build-logs .#checks.x86_64-linux.deploy-schema .#checks.x86_64-linux.deploy-activate .#checks.x86_64-linux.srv-hatchi-deploy-rejection
./bin/traitor verify srv-hatchi install-vm
./bin/traitor verify srv-hatchi services-vm
```

CI separates the two KVM tests and builds both deployment profiles without activating them. `deploy-activate` includes Nana's real closure and may need substantial disk space. Failure artifacts include command exits, runner facts, derivations, `nix log`, build logs, and the Nix daemon journal. The user authorized branch pushes and hosted execution. The existing workflow supports a branch `workflow_dispatch` trigger.

## Runtime assertions awaiting execution

The installed bootstrap must exchange SSH host keys through its firewall from an isolated network namespace. The production VM must prove all retained units, inventory-bound DNS and routes, service-specific upstream identities, separate client/admin CIDRs, IPv4 and IPv6 isolation, and removed services.

The VM also checks receipt refusal, Sonarr ownership, media permissions, node metrics, Grafana's datasource, native Nextcloud health and WebDAV persistence, AdGuard and qBittorrent rotation, retained qBittorrent restored/UI settings, CouchDB old-password rejection, and reboot. Caddy and promtool validate their generated configurations inside the VM.

## Historical runner evidence

The earlier generic `nixos-anywhere --vm-test` attempt exited 1 due to the x86 Linux platform requirement on this ARM Darwin controller. It did not install a VM. That generic app no longer exists.

The earlier OrbStack command rejected emulated amd64 NixOS on Apple Silicon. No machine was created, and the prior task stopped the OrbStack service it had started. This correction pass did not start OrbStack.

Hardware, physical disks, NICs, GPU acceleration, Cloudflare issuance, tailnet ACLs, live Nana connectivity, source data versions, backups, and restoration remain outside this run. See [commissioning](commissioning.md).

## Attention

The current owner read all 43 staged files and the inherited review findings. Pinned upstream implementations confirm bootstrap firewall ownership, native state-directory handling, qBittorrent configuration ownership, ACME dependencies, CouchDB configuration precedence, and the VM-only installer path. Local policy and rejection checks were rerun, not inferred from prior claims.

Independent and cross-model reviews are skipped under the user's no-subagent instruction. A dedicated Herdr verification tab is active during execution and must be removed before handoff. Hosted VM behavior remains NOT VERIFIED until the required jobs complete.
