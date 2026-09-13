# Hatchi 1Password verification

Hatchi can fetch application secrets from 1Password at runtime. The current SOPS provider remains the default until the missing migration keys are recovered and the host is commissioned.

## Enable the provider

Set `my.hatchi.onepassword.enable = true`. The references in `hosts/srv-hatchi/onepassword.nix` point to the existing Homelab items, including Glance's production session key.

Supply `my.hatchi.onepassword.references.grafanaKey` before enabling the provider. When restoring Grafana's database, this reference must resolve to its original encryption key. A newly generated key cannot decrypt the existing encrypted credentials.

Glance's `glancePassword` reference reads the built-in `password` field from `Chateau glance`, not its separate `hashed password` field. The normal password was verified against that bcrypt hash without printing either value. The `glanceKey` reference reads `add more/secret password`, a base64-encoded 64-byte session-signing key. Replacing this key invalidates sessions but does not erase the configuration or change the login password.

Missing references fail evaluation. Missing or invalid provider fields fail retrieval before any application files are rendered. The CouchDB username/password references use the Obsidian LiveSync item. A successful login to a fresh test database does not establish that this is the administrator of the old database. Confirm that separately before restoration.

Grafana's built-in password field uses the field ID `password`. Its displayed label is `confirmNew`, but that label failed resolution with the pinned 1Password SDK.

SOPS bootstraps the service-account token from the `opnix-token` key in `/var/lib/sops/srv-hatchi.yaml`, using `/var/lib/sops/age/keys.txt`. Provision both files out of band with mode `0600`. The token needs read access to Homelab, not write access. A direct runtime token file can instead be selected with `my.hatchi.onepassword.tokenFile`; it must not be a Nix store path.

## Runtime behavior

```text
SOPS bootstrap token
  → opnix-secrets.service fetches 1Password fields
  → hatchi-secret-files.service renders application files
  → dependent services start
```

Raw fields live under `/run/hatchi-onepassword`, owned by root with mode `0400`. Rendered files live under `/run/hatchi-secrets` with mode `0400`. Grafana owns its two files; systemd loads credentials for consumers that run as other users. No secret values are read during Nix evaluation.

The renderer converts the Cloudflare token into an ACME environment file, hashes AdGuard and qBittorrent passwords, renders their complete configurations, and builds CouchDB's administrator INI section. Glance, Grafana, and Nextcloud receive runtime password/key files. The renderer rejects missing, empty, multiline, and incompatible values rather than emitting partial configuration from invalid inputs.

Polling and opnix's automatic change watcher are disabled. The upstream unit limits repeated starts; inspect failures before using `systemctl reset-failed opnix-secrets.service` during deliberate maintenance. An explicit `systemctl restart opnix-secrets.service` refetches fields and restarts the renderer and dependent services. On a real host this interrupts those services. Grafana's bootstrap administrator password does not change existing database accounts automatically. Nextcloud creates the first administrator only when no users exist; it does not modify accounts in a restored database.

Nextcloud's upstream installer passes its administrator password in command-line arguments, which journald can retain as `_CMDLINE` metadata. Hatchi disables that initial account creation and uses a separate `nextcloud-admin.service` with the supported `NC_PASS` / `--password-from-env` interface instead. Nginx waits for this bootstrap to finish.

## Private integration test

`onepassword-machine.nix` composes the real Hatchi modules for a disposable NixOS machine named `hatchi-op-test`. It disables SSH, Tailscale, and production ACME, binds Caddy and AdGuard DNS to loopback, and uses a disposable media filesystem. Use a hypervisor-isolated network with internet access and no host home-directory sharing. Do not expose this test machine to the LAN or copy production databases into it.

The test module accepts `self` and `inputs` through NixOS `specialArgs`. Add the VM platform's hardware/container module separately. For OrbStack, retain its generated `/etc/nixos/configuration.nix`. The test performed here used arm64 NixOS userspace inside OrbStack's Linux VM. It verifies secret delivery and systemd/service behavior, not Hatchi's x86 kernel, physical disks, or hardware.

Use separate test-only Glance and Grafana keys, stored in 1Password. The private test module defaults both references to null instead of inheriting production keys. Never substitute them for restoration keys. Create a short-lived, read-only service account for the test. Stream its token through stdin into the private machine; do not put it in shell arguments, the checkout, a flake input, or build logs. For reboot verification, encrypt it into the VM's SOPS file with a VM-only age key.

Build with the dotfiles flake's pinned inputs. If copying a working tree into a private flake, use `--override-input dotfiles path:/root/dotfiles` so a cached path-input lock does not hide later edits. Use `nixos-rebuild boot` to install the test generation before restarting the machine; setting only the system profile does not update the container's `/sbin/init`.

After startup, run inside the disposable machine:

```sh
systemctl is-system-running --wait
python /root/dotfiles/tests/srv-hatchi/onepassword-live.py
```

The checker accepts only root on `hatchi-op-test`. It prints pass/fail labels without passwords, hashes, cookies, or response bodies. It waits for the renderer and HTTP listeners, then checks file permissions and authenticates to AdGuard, Grafana, CouchDB, Glance, qBittorrent, and Nextcloud WebDAV using the fetched passwords. Grafana's `Type=simple` unit becomes active before its HTTP listener, so the checker waits for `/api/health` before making the login assertion. Cloudflare's token is fetched and its file format checked, but the test does not perform DNS writes or validate its zone permissions.

Repeat after restarting `opnix-secrets.service` and after rebooting. A provider failure must leave dependent services stopped. Destroy the disposable machine and its bootstrap key after testing, and retire the temporary 1Password records. No real-secret test belongs in public CI.

## Local checks

```sh
traitor check --print-build-logs
nix build --no-link .#checks.aarch64-darwin.srv-hatchi-onepassword-formats
```

The format tests use synthetic values and run in the existing Hatchi CI build step. Existing SOPS credential fixtures remain unchanged. The local policy check verifies provider selection, missing-key assertions, runtime paths, and service ordering. Policy and Fleet tests are still not run by CI.
