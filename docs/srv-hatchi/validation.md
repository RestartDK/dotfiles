# Migration validation ledger

The migration starts at `c6de1f6ee713be8bc2b73b047e245ca2a7d08e16` on `daniel/nixos-srv-hatchi`. GPT-6 Astra with xhigh reasoning owns this completion pass without subagents. The canonical checkout and live hosts remain untouched.

## Current result

The review corrections pass local policy tests, the real VM-only CLI rejection, formatting, actionlint, Darwin `traitor check`, and all-system evaluation. Both evaluated inline test-driver strings parse. The pinned deploy-rs schema accepts both node definitions. All existing root input pins and existing host/module files remain unchanged.

The pinned installed VM test passed on hosted x86 Linux/KVM at `bf9663b`. It booted the disposable installed disk, verified the hostname, exchanged SSH host keys from a separate network namespace through the firewall, and confirmed Nextcloud was absent.

Both Hachi closures, deploy-rs schema and activation-script checks for both hosts, and Hachi refusal in all four activation modes passed on hosted x86 Linux at `ebadb22`. The existing Home Manager output also evaluated successfully.

The production service VM remains NOT VERIFIED. The second run mounted the media fixture, passed receipt checks, and initialized native Nextcloud and PostgreSQL. Glance then rejected the malformed synthetic authentication key. The key was regenerated with its pinned native CLI, and a policy check now enforces the decoded 64-byte length. Later service and rotation assertions still require a passing run.

The controller is ARM Darwin. Nix reports `builders = @/etc/nix/machines`, but that file does not exist. No local configured x86 Linux/KVM executor is available. The authorized GitHub-hosted executor is working. OrbStack's known amd64 emulation failure was not repeated. Hosted VM commands ran only against disposable guests. No live-host access occurred.

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

## Hosted run 34657739803

[Workflow dispatch](https://github.com/RestartDK/dotfiles/actions/runs/34657739803) used branch head `bf9663beee2d0a65da09e34e2688b4b7edd68504`. Both Hachi jobs passed the explicit x86 Linux and KVM prerequisite.

| Job | Result | Observed behavior |
| --- | --- | --- |
| [Install VM](https://github.com/RestartDK/dotfiles/actions/runs/34657739803/job/103453681432) | VERIFIED, exit 0 | The pinned VM-only entrypoint installed the disposable Disko configuration, booted it, and exchanged SSH host keys through the firewall. The driver finished in 60.30 seconds. |
| [Darwin](https://github.com/RestartDK/dotfiles/actions/runs/34657739803/job/103453681126) | VERIFIED | Quality, policy, and both Darwin configuration evaluations passed. |
| [Services VM](https://github.com/RestartDK/dotfiles/actions/runs/34657739803/job/103453681331) | Failed, exit 1 | Admission blocked setup as intended. The test's ordinary `fileSystems` declaration was replaced by the QEMU module, so `/srv/media` was absent. |
| [Linux](https://github.com/RestartDK/dotfiles/actions/runs/34657739803/job/103453681329) | Failed, exit 1 | A shell stub required `/usr/bin/env`, which is absent in the Linux build sandbox. Other requested builds were cancelled, not passed. |

The media fixture now uses `virtualisation.fileSystems`, with an evaluation assertion and an explicit mounted-source check. Local before/after evaluation proves that `/srv/media` was absent before the fix and present with the intended device and filesystem afterward. The policy stub now uses `pkgs.writeShellScriptBin`, which supplies the pinned interpreter. No assertion was removed or relaxed.

CI now runs quality and policy before either Hachi closure or deploy profile builds. Its Linux daemon uses the same Numtide cache and public key already declared by the repository's NixOS cache module, rather than compiling cached agent packages unnecessarily.

## Hosted run 34660883503

[The second full dispatch](https://github.com/RestartDK/dotfiles/actions/runs/34660883503) used `ebadb22`. [Linux verification](https://github.com/RestartDK/dotfiles/actions/runs/34660883503/job/103462953179) passed quality, policy, both Hachi closure builds, both deploy-rs checks, all four Hachi activation refusals, and the existing Home Manager evaluation. The install VM and Darwin jobs also passed.

[The service VM](https://github.com/RestartDK/dotfiles/actions/runs/34660883503/job/103462953225) passed the media mount and receipt checks. Its logs record successful Nextcloud installation and PostgreSQL startup. Glance exited because the synthetic key was not base64, so the service test failed with exit 1. Startup logs are not counted as proof of the remaining HTTP, firewall, persistence, or rotation assertions.

## Hosted run 34661892039

The [services-only dispatch](https://github.com/RestartDK/dotfiles/actions/runs/34661892039/job/103465927617) at `cce7d92` started every requested service but timed out connecting to DNS on loopback. AdGuard logged its TCP listener. The production `trustedInterfaces = lib.mkForce []` had removed NixOS's loopback allow rule, blocking local clients and reverse proxies. The configuration and policy now require exactly `[ "lo" ]`; external CIDR restrictions remain unchanged.

This diagnostic scope does not count as a full CI pass. Pull requests and pushes always run every job.

## Hosted run 34663545232

The [fourth service dispatch](https://github.com/RestartDK/dotfiles/actions/runs/34663545232/job/103470794430) at `21a51a2` reached all expected loopback listeners and loaded every retained unit. The first client DNS rewrite assertion then failed. Pinned AdGuard 0.107.78 skips rewrite entries unless their `enabled` field is true. Declarative entries now set that field explicitly. The test still requires every inventory-derived name over both UDP and TCP and reports the received answer on failure.

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
