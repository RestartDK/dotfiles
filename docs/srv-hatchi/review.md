# Accepted review corrections

All inherited findings are accepted and reproduced below as durable review context. None are rejected. Hosted Linux builds, activation refusal, the installed VM, and the complete production VM have passed. [The validation ledger](validation.md) binds each proof to its revision; full delivery-head CI remains required.

## Correctness findings

| Finding | Correction | Evidence |
| --- | --- | --- |
| C1. Bootstrap SSH was firewalled | Broad port removal now belongs to production `edge.nix`. Bootstrap inherits TCP 22. The installed VM probes SSH from a separate network namespace. | `foundation.nix`, `edge.nix`, `tests/srv-hatchi/install.nix`, policy assertion |
| C2. Sonarr state had no creator | Systemd owns `/var/lib/sonarr` with `StateDirectoryMode=0700`. | `services/media.nix`, policy assertion |
| C3. qBittorrent erased settings | Native `serverConfig` stays empty. One shell tool merges baseline and runtime credential into existing INI with private staging and atomic rename. | `services/qbittorrent-config.nix`, shell policy, retained restored key and UI setting across VM restarts |
| C4. ACME renewal bypassed admission | Certificate and order/renew units both require admission and SOPS, with ordering. | `edge.nix`, generated-unit and option assertions in `policy.nix` |
| C5. CouchDB rotation lost to local.ini | Systemd seeds the final writable `/run/couchdb/local.ini` from `LoadCredential` on each start. Persistent local.ini is no longer loaded. | `services/couchdb.nix`, final ERL_FLAGS assertion, VM old-password rejection after two restarts |
| C6. Grafana cookie lacked Secure | Set `security.cookie_secure=true`. | `services/monitoring.nix`, policy assertion |
| C7. Generic installer contradicted docs | Delete the raw app. Export only `srv-hatchi-install-vm`, bound to the immutable flake source and bootstrap selector. | `flake.nix`, `tests/srv-hatchi/install-vm.nix`, actual CLI rejection |

Paths without a prefix in this table are under `hosts/srv-hatchi`.

## Security and blast-radius findings

| Finding | Disposition |
| --- | --- |
| S1. Raw nixos-anywhere allowed destructive overrides | Accepted and removed. The replacement rejects every argument before upstream invocation. Tests cover target, store paths, phases, extra files, flake replacement, and multiple arguments. |
| S2. ACME renewal bypass | Accepted. Same fix as C4. |
| S3. Keep Hachi activation refusal in normal, dry, boot, and test modes | Preserved. Exact-node CLI refusal passes locally. The Linux executable rejected all four activation modes in [run 34660883503](https://github.com/RestartDK/dotfiles/actions/runs/34660883503/job/103462953179). |
| S4. Keep deploy checks non-activating and CI free of deployment | Preserved. CI builds profiles but invokes no deploy command. |
| S5. Keep production secrets outside the store and fixture overrides test-only | Preserved. Runtime paths remain under `/run/secrets`. Synthetic fixture paths occur only in tests. |

The safety fact has local executable proof for missing destructive outputs, exact-node CLI refusal, and the fixed VM-only wrapper. The pinned upstream `src/nixos-anywhere.sh` at `9df41112343713520ba071674cf8e45e91c25845` handles `--vm-test` before disk or SSH work. Its `runVmTest` builds only `system.build.installTest`. Linux activation and actual VM boot are not proved by these local checks.

## Verification findings

| Finding | Correction |
| --- | --- |
| H1. Client and admin shared a CIDR | Separate VMs use `.20/32` and `.50/32`, plus distinct IPv6 `/128` addresses. Client probes DNS and HTTP but cannot use SSH. Admin probes SSH but cannot reach DNS, edge HTTP, or backends. |
| H2. Ollama and OpenCode shared a marker | Native nginx serves unique markers on ports 8000 and 8001. Each route must return its own marker. |
| H3. Servarr ping payloads were indistinguishable | Fetch authenticated system status from each direct backend and proxy. Require the expected `appName` and matching instance identity. |
| H4. Inventory lacked pinned-source proof | `source-manifest.json` records URL, SHA-256, active names, and images. Policy fetches the hash-pinned Compose file and compares its normalized service map. Counts stay fixed at 17 sources and 16 native replacements. |
| H5. Route coverage drifted from inventory | Inline test loads inventory, derives expected DNS and HTTP names, and requires equality with exercised service-specific checks. Removed names remain explicit negative tests. |
| H6. Install test did not prove network reachability | SSH host-key exchange originates in a separate namespace over a disposable veth pair through the installed host firewall. No test-only port override remains. |
| H7. Restart tests raced readiness | AdGuard, qBittorrent, CouchDB, and post-reboot Nextcloud checks wait for authenticated endpoint readiness. |
| H8. CI missed daemon and derivation logs | Retain `nix log` for known and reported derivations, recursive derivation metadata, build-directory logs, and the Nix daemon journal. |

## User requirement and architecture constraints

No task `.py` file remains in Git or in either Hachi directory. Admission uses a pinned shell application and jq predicate. AdGuard uses jq and yq. qBittorrent uses a small shell INI merge with pinned gawk and coreutils. CouchDB uses native systemd credentials and its native final config-file option. No replacement scripting framework was added. Driver Python exists only inline in `.nix` test strings.

Candidate 2 remains the base. Service-owned native modules, typed configuration boundaries, independent inventory, stock Caddy, and `security.acme` remain. There is no topology DSL, Jellyseerr alias, Open WebUI service, physical install output, or broad Hachi deployment path.

No new narrating code comments were added. The current owner applied the no-comments rubric directly. Two redundant metadata comments were removed from the public test age identity. No comments were restored, and no scoped suppression needs removal. Existing dependency explanations in unchanged code remain outside the migration diff.

## Direct completion review

GPT-6 Astra with xhigh reasoning read every staged file, the source Compose file at the recorded revision, and the pinned lifecycle code for qBittorrent, AdGuard, CouchDB, Caddy, deploy-rs, and nixos-anywhere. The source inventory still contains 17 active services, not Open WebUI. The generic installer app is absent. Upstream `--vm-test` exits after building only `system.build.installTest`, before SSH or disk mutation.

The safety fact is that no uncommissioned Hachi output grants physical disk or activation authority. Local tests rerun the actual packaged argument rejection, exact-node CLI rejection, receipt checks, credential merge tests, and generated dependency assertions. Hosted activation refusal and both VMs have passed. Runtime failures exposed an absent fixture mount, malformed Glance fixture key, production loopback rejection, disabled DNS rewrites, and stale test expectations. Corrections use the pinned native interfaces. The final service run includes authenticated identities, every firewall probe, credentials, permissions, and post-reboot Nextcloud persistence.

All prior review findings have code-level corrections. Their runtime claims remain separate from evaluation. Cross-model review and delegation are explicitly skipped because the user forbids subagents.
