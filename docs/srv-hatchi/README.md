# Hachi migration reference

The dotfiles flake owns 16 native replacements for the 17 active services in [the pinned source stack](https://github.com/RestartDK/homelab/blob/2c70dbecd6f421ba03038b0cc203592149d05a9c/docker-compose.yml). Portainer is removed. Seerr has no Jellyseerr alias. Cockpit, Nextcloud AIO, and Open WebUI have no unit or route.

## Outputs

| Output | Meaning |
| --- | --- |
| `nixosModules.srv-hatchi-bootstrap` | Shared headless foundation, SSH, and Tailscale. No application initialization. |
| `nixosModules.srv-hatchi` | The same foundation with native service modules. Hardware-independent. |
| `nixosConfigurations.srv-hatchi-bootstrap` | Uncommissioned reference closure, not a physical installation image. Its `installTest` comes from the separate disposable Disko composition. |
| `nixosConfigurations.srv-hatchi` | Uncommissioned reference closure with all production services. No physical Disko outputs. |
| `apps.<system>.srv-hatchi-install-vm` | Zero-argument verifier pinned to this flake's bootstrap `installTest`. No generic installer app. |
| `deploy.nodes.srv-nana` | Existing Nana configuration with strict SSH host-key checking and deploy-rs rollback. No automatic deployment. |
| `deploy.nodes.srv-hatchi` | Reserved non-routable target and a rejecting activation profile in every activation mode. |

Nana's workstation modules and both Darwin hosts remain unchanged. Docker remains enabled on Nana and explicitly disabled on Hachi. The reference filesystem label and QEMU profile live under `tests/srv-hatchi/fixtures/`. Only `tests/srv-hatchi/install.nix` selects `/dev/vda`.

## Ownership

Service modules own native `services.*` options, ports, routes, credentials, and admission dependencies. `edge.nix` projects validated Caddy hostnames and aliases into AdGuard rewrites and Glance links. The independent migration inventory lives in `tests/srv-hatchi/inventory.json`. `source-manifest.json` records the pinned Compose URL, SHA-256, and normalized active service names and images. The policy check fetches and verifies that source, then compares its 17 active names with the inventory.

Stock Caddy consumes a wildcard certificate from `security.acme` with Cloudflare DNS-01. No custom Caddy plugin is built. Nextcloud 33 uses native PostgreSQL, Redis, PHP-FPM, and loopback nginx. PostgreSQL uses socket authentication.

## Deferred facts

Bootstrap admits SSH on TCP 22. Production replaces that broad allowance with the CIDR rules in `edge.nix`.

`my.hatchi.network = null` means no application ingress or DNS rewrites are admitted. A configured network supplies the DNS answer, client CIDRs, admin CIDRs, and upstream resolvers. IPv4 and IPv6 rules use the same CIDR policy. Tailscale's native preference unit sets `--netfilter-mode=off`. No interface is blanket-trusted.

`my.hatchi.remoteNana = null` keeps Ollama and OpenCode routes at an explicit HTTP 503. No guessed Nana address is contacted. A configured record supplies Ollama, OpenCode, node-exporter, and Glance-agent endpoints. This adds no Nana services.

qBittorrent's inbound peer port is not admitted in this pass. Its Web UI is loopback-only. The source peer port was in the ignored environment file. GPU acceleration, hardware identities, physical interfaces, network facts, and real data remain unknown.

## Credentials

Each consumer declares its sops secret. Production expects the encrypted bundle at `/var/lib/sops/srv-hatchi.yaml` and the age identity at `/var/lib/sops/age/keys.txt`. Neither file exists in this repository. The runtime source is an unprovisioned boundary, not an alternative configuration repository. Commissioning must add recipient policy and real ciphertext to dotfiles and replace the unprovisioned bundle path in a reviewed change.

The first-pass closure builds without secret contents. Missing ciphertext or identity fails `sops-install-secrets` before consumers start. No dummy production ciphertext, plaintext password, or production recipient is included. VM fixtures contain a deliberately public test identity and synthetic ciphertext.

AdGuard accepts only nonempty bcrypt-authenticated users. qBittorrent accepts only a correctly encoded PBKDF2 credential. AdGuard merges users into its native public configuration. qBittorrent leaves native `serverConfig` empty. One atomic merge preserves existing settings while replacing the public baseline and credential. Both helpers are shell applications built with pinned packages. No task Python files remain.

Glance requires a base64-encoded 64-byte authentication key from its native `glance secret:make` command. Arbitrary text is not a valid key. The policy check decrypts only the public fixture bundle and checks this format without printing its value.

CouchDB loads a private `/run/couchdb/local.ini` last. Systemd loads the admin credential and copies it into this writable runtime file before each start. CouchDB can hash the password there without overriding the next secret rotation. Its public configuration belongs in `services.couchdb.extraConfig`. Runtime API configuration changes are not persistent. Glance, Grafana, Suwayomi, and Nextcloud retain their native runtime-file interfaces.

See [commissioning prerequisites](commissioning.md), [restore admission](restore.md), and [actual verification results](validation.md).
