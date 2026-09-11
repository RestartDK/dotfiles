# Admit application state

No source data has been read or restored. Use [the source-to-target inventory](data-inventory.tsv) as a plan, not a record of live volumes.

## Prepare a later restore

1. Stop the affected applications before restoring any data.
2. Compare the source application and database versions with the pinned native packages. Rehearse supported upgrade paths on disposable copies.
3. Mount the verified destination at `/srv/media`. The target directories are `movies`, `tvshows`, `manga`, and `downloads`.
4. Restore native state with its native service owner. Rewrite container paths only after a version-aware restore plan is reviewed.
5. Validate data, accounts, database consistency, media paths, and backups before creating an admission receipt.

Do not restore CouchDB `local.ini`. Declare public settings in Nix and provide the `[admins]` stanza through `couchdb-admin`. Rotation replaces the SOPS secret and restarts CouchDB. Its final writable config is regenerated from that secret on every start.

qBittorrent preserves restored and UI settings outside its owned baseline keys. Nix owns the legal notice, download path, Web UI bind address, username, server domains, and authentication protections. The runtime credential owns `WebUI\Password_PBKDF2`. Sonarr state remains `/var/lib/sonarr`, created privately by systemd with the Sonarr owner.

Do not restore Caddy state. Issue new certificates. Fresh Prometheus history is acceptable after an explicit decision. The Nextcloud AIO master volume is insufficient. Nextcloud needs a supported logical database export, the data directory, configuration, apps, and a compatible major-version path. Keep maintenance mode enabled during rehearsal. Rehearse the Jellyseerr-to-Seerr migration separately.

Do not restore Tailscale daemon state into an uncommissioned host. Establish the approved netfilter preference before joining the tailnet.

## Receipt format

`/var/lib/hatchi/admission.json` is a root-owned regular file with mode `0600` inside a root-owned directory that other users cannot write. `hosts/srv-hatchi/admission.nix` checks filesystem ownership and mount identity. Its pinned jq parser is `admission.jq`. `hatchi-check-admission` runs the same check without starting applications.

The top-level keys are `version`, `machineId`, `mediaIdentity`, and `services`. Version is `1`. The machine ID must equal `/etc/machine-id`. The media identity contains the mounted source, filesystem type, and root from the kernel mount table. The service set must match every service-owned admission dependency exactly.

Each service entry has a `state` of `fresh` or `restored` and a 64-character SHA-256 `reviewDigest`. A restored entry also requires `backupDigest`, `sourceVersion`, and `procedureVersion`. A missing service, malformed digest, wrong destination identity, absent mount, or unprotected receipt fails admission.

The receipt verifies an attestation's shape and current mount identity. It does not prove that its hashes describe real backups. The later commissioning tool must bind physical filesystem UUIDs and verified restore evidence before issuing physical receipts. No receipt-issuing production command exists in this pass.

## Startup boundary

Both ACME certificate and order/renew units require admission and secret readiness. Every state-writing application and Nextcloud database or setup dependency requires `hatchi-admission.service`. The checker is a oneshot without retained active state, so a new dependency start reruns it. Media services additionally require `/srv/media` to be a mount, not an ordinary directory. Directory creation runs only after admission. Activation never restores data or creates a receipt.

The fixed `media` GID is `1600`. Writers use their own UIDs. Radarr can write movies and downloads, Sonarr can write TV shows and downloads, qBittorrent can write downloads, and Suwayomi can write manga. Systemd makes the other shared paths read-only. Jellyfin and Komga see shared media read-only. Native application state stays under `/var/lib`.

A receipt does not continuously monitor an already running application. Stop the stateful stack before changing mounted storage or revoking admission. Filesystem removal still needs a physical operational procedure and is not authorized by this configuration.
