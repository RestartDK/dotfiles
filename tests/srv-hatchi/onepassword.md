# Hatchi 1Password secrets

Nix owns application configuration. opnix fetches service-ready credentials into runtime files. The existing SOPS provider remains the default. Neither provider enables deployment or commissions the host.

## Credential contract

Set each `my.hatchi.onepassword.references` option to a field containing the following value, not the field's reference text.

| Option | Field content |
| --- | --- |
| `cloudflare` | An ACME environment file containing `CF_DNS_API_TOKEN=<token>` |
| `adguardPasswordHash` | The complete bcrypt password hash for `daniel` |
| `couchdbAdmin` | An INI fragment with an `[admins]` section and the administrator's `username = password` entry |
| `glanceKey` | A base64-encoded 64-byte session-signing key |
| `glancePassword` | The normal Glance login password |
| `grafanaKey` | Grafana's encryption key |
| `grafanaPassword` | The initial Grafana administrator password |
| `nextcloudPassword` | The initial Nextcloud administrator password |
| `qbittorrentPasswordHash` | The complete qBittorrent `@ByteArray(base64-salt:base64-digest)` value for `daniel`, using PBKDF2-HMAC-SHA512 with 100000 iterations |

The Cloudflare environment file, CouchDB INI fragment, both password hashes, and Grafana's key have null references until provisioned. Do not point these options at the old plain-token or plain-password fields. Store only credentials and their required wrappers in these fields, not entire application configurations.

Changing an AdGuard or qBittorrent password requires updating its stored hash too. Obtain each hash with the application's supported tooling or configuration export. Hashes are not generated at boot. Changing Cloudflare or CouchDB credentials also requires updating the corresponding environment or INI field. Keep any separate login fields in sync.

The existing Glance references retain the normal `password` field and the `add more/secret password` session key. Do not substitute Glance's separate `hashed password` field for its normal password. A new session key invalidates sessions but does not erase configuration. Grafana instead needs its original encryption key when restoring encrypted database credentials. Its password reference uses the built-in field ID `password`, not its displayed label `confirmNew`.

A fresh CouchDB administrator login does not prove access to a restored database. Confirm the existing administrator and Grafana restoration key before migration.

## Bootstrap and runtime

Only after provisioning every reference, set `my.hatchi.onepassword.enable = true`. Missing references fail evaluation.

SOPS decrypts the `opnix-token` entry from `/var/lib/sops/srv-hatchi.yaml` using `/var/lib/sops/age/keys.txt`. Provision both files out of band, root-owned with mode `0600`. The service account needs read access to the vault, not write access. `my.hatchi.onepassword.tokenFile` can instead select a separately provisioned runtime token file outside the Nix store.

```text
SOPS bootstrap token
  → opnix-secrets.service fetches nine credential files
  → hatchi-secret-files.service substitutes two stored hashes
  → dependent services start
```

opnix writes files under `/run/hatchi-onepassword` with mode `0400`. Grafana owns its two files; root owns the others. Most consumers use these files directly. AdGuard and qBittorrent receive Nix-generated configurations under `/run/hatchi-secrets`, with their stored hashes substituted through Nixpkgs' `replace-secret` utility. That upstream utility uses Python internally; this repository has no custom Python renderer, manifest, or hashing code.

The two generated configurations are root-owned `0400` files in a `0700` directory. systemd passes them through `LoadCredential`. Secret values never enter Nix evaluation or command-line arguments. Failed retrieval or empty files prevent dependent startup. Service-ready field syntax is the operator's responsibility; this is not a general-purpose secret-format validator.

Polling and the automatic change watcher remain disabled. `systemctl restart opnix-secrets.service` refetches credentials and restarts dependent services. This interrupts applications. Inspect failures before clearing the upstream start limit with `systemctl reset-failed opnix-secrets.service` and restarting failed consumers.

Grafana's initial administrator password does not rotate existing database accounts. Nextcloud creates its first administrator only if no users exist. Its separate credential-backed service uses `NC_PASS` and `--password-from-env`, rather than the upstream installer's password argument that journald can retain. Nginx waits for that service.

## Verification

```sh
traitor check --print-build-logs
nix build --no-link --print-build-logs .#checks.x86_64-linux.srv-hatchi-onepassword
```

The second command requires x86 Linux with KVM. It uses the standard NixOS VM test driver and public synthetic SOPS fixtures. A test-only fetch command replaces the 1Password network call, but the provider unit, runtime substitutions, credentials, and real services are exercised. The test checks six logins, permissions, provider restart propagation, missing-token and empty-file failures, and reboot. It runs alongside the existing SOPS services VM in CI. Policy and Fleet tests remain local-only.

This test does not authenticate to 1Password or validate production field references. Earlier private SDK testing covered the superseded plain-password renderer, not this service-ready field contract.

For a later private SDK check, `onepassword-machine.nix` composes the real modules without SSH, Tailscale, production ACME, or production data. Supply the VM platform separately, explicit test-only key references, and service-ready fixture fields in a test vault. Its Glance and Grafana key references default to null to prevent production-key inheritance. Use a short-lived read-only account, stream its token through stdin, and retire the account and VM afterward. Do not put real credentials in public tests or rebuild the revoked earlier test account implicitly.
