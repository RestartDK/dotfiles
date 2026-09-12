# Migration validation ledger

Base `c6de1f6ee713be8bc2b73b047e245ca2a7d08e16`. Branch `daniel/nixos-srv-hatchi`. GPT-6 Astra with xhigh reasoning owns this pass without subagents. The canonical checkout and both live hosts remain untouched.

## Verified results

| Proof | Revision and evidence | Result |
| --- | --- | --- |
| Both Hachi closures, both deploy-rs profile checks, schema, all four Hachi activation refusals, existing Home Manager evaluation | `ebadb22`, [hosted Linux](https://github.com/RestartDK/dotfiles/actions/runs/34660883503/job/103462953179) | Passed, exit 0. No host activation or SSH connection. |
| Pinned `nixos-anywhere --vm-test` | `bf9663b`, [installed VM](https://github.com/RestartDK/dotfiles/actions/runs/34657739803/job/103453681432); repeated at `ebadb22` | Passed. Disposable Disko install, installed-disk boot, hostname, root mount, SSH host-key exchange through the firewall from a separate network namespace, and no Nextcloud. First driver completed in 60.30 seconds. |
| Complete production service VM | `a2de8073a2c19036d3b7e2db9be4513a0bb5c6c4`, [hosted KVM](https://github.com/RestartDK/dotfiles/actions/runs/34667334950/job/103481810331) | Passed, exit 0. Driver completed in 447.92 seconds and stopped all five guests. |
| Local policy, actual CLI rejection, formatting, actionlint, Darwin checks, all-system evaluation, driver syntax, immutable existing pins and host files, zero new Python paths | [commands.tsv](commands.tsv), through `wave9` | Passed. Evaluation is not Linux runtime proof. |

## Full PR verification

[PR #147](https://github.com/RestartDK/dotfiles/pull/147) opened non-draft with a 237-word description and the required Linear-unavailable note. [Run 34668163263](https://github.com/RestartDK/dotfiles/actions/runs/34668163263) verified head `f6f08551bf3a9708a52c991d6fdc9c7ccb1c14f0`. All four jobs passed, with none skipped:

- [Linux](https://github.com/RestartDK/dotfiles/actions/runs/34668163263/job/103484241892) passed policy, quality, both closures, both deploy checks, all four refusal executions, and existing Home Manager evaluation.
- [Darwin](https://github.com/RestartDK/dotfiles/actions/runs/34668163263/job/103484242022) passed its checks and configuration evaluations.
- [Installed VM](https://github.com/RestartDK/dotfiles/actions/runs/34668163263/job/103484242029) passed the fixed VM-only command.
- [Production service VM](https://github.com/RestartDK/dotfiles/actions/runs/34668163263/job/103484242032) passed every assertion again. The driver completed in 533.09 seconds and stopped all five guests.

The repository `watch-pr` ran in Babysit `drive` mode and exited 0 with `READY`, GitHub merge state `CLEAN`, zero review threads, zero pending checks, and zero failures. [babysit.json](babysit.json) preserves that snapshot and its checked revision. No review finding required a fix or dismissal. The PR was not merged.

This audit-only commit requires another full PR run and watcher rearm. Its final result and local tab teardown belong in the delivery report, not a claim about a future command. The earlier services-only dispatch remains diagnostic evidence, not a full CI pass.

The controller is ARM Darwin with no configured Linux builder. All runtime VM evidence came from authorized GitHub-hosted x86 Linux/KVM. No live-host access occurred.

## Observed production VM behavior

The test imports production modules and replaces only disposable network, credential, storage, and certificate facts. It proved:

- Missing admission blocks application and database initialization. Receipts with unsafe permissions or a missing media mount reject. The valid receipt admits native services.
- All 16 retained native service units load. All inventory-derived DNS rewrites work over UDP and TCP. Forwarding, removed-name negatives, HTTP redirects, application identities, and distinct remote proxy markers pass.
- Client and admin CIDRs remain separate. IPv4 and IPv6 client/admin/outsider probes enforce the intended access. Every binding on each private application port is loopback, including Java's IPv4-mapped IPv6 sockets. Removed container and administration units and the Docker socket are absent.
- Prometheus scrapes three targets. Node metrics identify Hachi and fixture Nana separately. Grafana requires authentication and queries its provisioned Prometheus datasource.
- Native Nextcloud passes HTTP and CLI health, WebDAV upload/download, and cron. Its file survives an actual guest reboot. Post-boot HTTP and CLI health and DNS pass.
- Media writers can write their directories. Jellyfin and Komga cannot write through their service mount namespaces. Unrelated users cannot read protected secrets or private application configuration.
- AdGuard and qBittorrent accept rotated credentials and reject the previous credentials. qBittorrent retains restored and UI settings across restarts and rotation. CouchDB rejects the old credential after rotation and after another restart.
- Caddy validates both production certificate-file configuration and the fixture configuration. Prometheus validates its generated configuration.

No cloud certificate was issued. Fixture Nana returns synthetic identities, not evidence about live Nana. Offline update probes failed as expected. Komga also warned that libarchive could not load; real archive-format and library-data compatibility remain unverified.

## Rerunnable commands

Run the Linux commands on x86 Linux with KVM. None contacts either live host.

```sh
./bin/traitor check --all-systems --no-build --print-build-logs
./bin/traitor verify srv-hatchi policy
./bin/traitor verify srv-hatchi closures
nix build --no-link --print-build-logs .#checks.x86_64-linux.deploy-schema .#checks.x86_64-linux.deploy-activate .#checks.x86_64-linux.srv-hatchi-deploy-rejection
./bin/traitor verify srv-hatchi install-vm
./bin/traitor verify srv-hatchi services-vm
```

Local `traitor check --print-build-logs` passes Darwin quality and policy checks. `traitor check --all-systems --no-build --print-build-logs` evaluates all named outputs without Linux builds. Both complete inline driver strings parse.

The real packaged `nix run .#srv-hatchi-install-vm -- --store-paths /nix/store/refused /nix/store/refused` rejects with exit 2. `./bin/traitor deploy srv-hatchi --dry-run` rejects with exit 1. Ledger wrappers exit 0 only after checking these expected rejection codes.

Raw Nix is limited to diagnostics that `traitor` does not expose. New CLI paths use `./bin/traitor` because the PATH binary belongs to the untouched canonical checkout. `traitor check` resolves this worktree from its current directory.

CI separates the two KVM tests and builds both deployment profiles without activating them. `deploy-activate` includes Nana's real closure and needs substantial disk space. Evidence artifacts record command exits, runner facts, commit and lock digests. Failures also retain derivations, `nix log`, build logs, and the Nix daemon journal. Non-dispatch runs execute every required job.

## Hosted failures and corrections

All listed service failures exited 1. None counts as a complete pass. The code and test corrections preserve the required behaviors.

| Run and head | Failure | Correction |
| --- | --- | --- |
| [34657739803](https://github.com/RestartDK/dotfiles/actions/runs/34657739803), `bf9663b` | QEMU discarded the ordinary media filesystem declaration. Linux policy also required absent `/usr/bin/env`; dependent builds were cancelled. | Use native `virtualisation.fileSystems`, assert the mount at evaluation and runtime, and package the stub with `writeShellScriptBin`. Separate policy, closure, and deploy steps. |
| [34660883503](https://github.com/RestartDK/dotfiles/actions/runs/34660883503), `ebadb22` | Glance rejected the malformed synthetic key. Linux, Darwin, and installed VM passed. | Generate the key with pinned `glance secret:make`; enforce its decoded 64-byte length in policy. |
| [34661892039](https://github.com/RestartDK/dotfiles/actions/runs/34661892039), `cce7d92` | Production firewall blocked loopback despite listeners. | Require exactly `[ "lo" ]` as trusted interfaces. External and Tailscale interfaces remain CIDR-restricted. |
| [34663545232](https://github.com/RestartDK/dotfiles/actions/runs/34663545232), `21a51a2` | AdGuard ignored declarative rewrites. | Set each entry's required `enabled = true`. |
| [34664193750](https://github.com/RestartDK/dotfiles/actions/runs/34664193750), `55ec780` | Public AdGuard login markup did not contain the product name. | Assert exact public and authenticated page titles from the pinned templates, plus API identity. |
| [34664884702](https://github.com/RestartDK/dotfiles/actions/runs/34664884702), `64c9f89` | qBittorrent's successful empty response did not equal obsolete `Ok.`. | Require current HTTP 204/401 semantics and the authenticated packaged version. PBKDF2 and native Qt decoding passed separate diagnostics. |
| [34665763616](https://github.com/RestartDK/dotfiles/actions/runs/34665763616), `315edfa` | Text matching rejected Java's mapped loopback notation. | Parse addresses and require every private binding to be loopback. Captured sockets pass; wildcard and external addresses reject. |
| [34666487510](https://github.com/RestartDK/dotfiles/actions/runs/34666487510), `244ec02` | Every pre-reboot assertion passed, but default `-no-reboot` made QEMU exit. | Start Hachi with the driver's supported `allow_reboot=True`. The next run passed reboot and persistence. |

## Audit boundaries

[commands.tsv](commands.tsv) records exact commands, exits, and evidence pointers. [decisions.tsv](decisions.tsv) records the decisions. `astra-` and `wave` rows belong to this completion pass. Earlier rows are inherited history, not substitutes for current verification. Temporary paths are diagnostic pointers, not durable hosted proof.

Inherited failures included INI idempotence, a non-rejecting shell expression, formatting, sudo redirection, and incorrect driver-string coercion. Their corrections remain in the ledger and [accepted review mapping](review.md). The old generic installer and OrbStack attempts did not produce VM proof. This pass did not repeat the known emulation failure or start OrbStack.

The owner reviewed all 43 staged files and pinned lifecycle implementations directly. Independent and cross-model workers were skipped because the user forbids subagents. Session metadata records only GPT-6 Astra and xhigh reasoning, with zero subagent calls.

Hardware, physical disks, NICs, boot mode, GPU acceleration, Cloudflare issuance, tailnet ACLs, live Nana connectivity, source data versions, backups, archive-format compatibility, and restoration remain outside this run. See [commissioning](commissioning.md) and [restore](restore.md). Hachi remains uncommissioned; no physical install or activation authority was added.
