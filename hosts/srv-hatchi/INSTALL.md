# Install Hatchi

This procedure erases both configured internal disks. It does not select the installer USB.

The Hatchi configuration identifies these disks:

- System SSD: `/dev/disk/by-id/ata-LITEON_CV8-8E128-11_SATA_128GB_TW059X3VLOH008BC01G0`
- Data HDD: `/dev/disk/by-id/ata-ST1000LM049-2GH172_WGS2R867`

## Prepare Hatchi

1. Merge the installation PR and update a clean local `main` branch.
2. Boot Hatchi from the NixOS installer in UEFI mode.
3. Set a root password, start SSH, and find Hatchi's address:

   ```bash
   sudo passwd root
   sudo systemctl start sshd
   ip -br addr
   ```

4. Add the Mac's SSH key and confirm root access:

   ```bash
   ssh-copy-id root@<HATCHI_IP>
   ssh root@<HATCHI_IP>
   ```

## Install NixOS

Before erasing disks, prepare the private bootstrap bundle at `~/.local/state/hatchi-bootstrap`. The installer refuses missing or empty files. The bundle must contain the production 1Password service-account token, not the public test fixtures.

From the clean `main` checkout on the Mac, run:

```bash
traitor install srv-hatchi root@<HATCHI_IP> --confirm-destroy
```

`traitor install` accepts no additional installer options. It checks the configured disk identifiers, branch, upstream revision, hardware facts, working tree, and presence of the bootstrap files. It stages the clone at `/home/dkumlin/.config/dotfiles` and the bootstrap at `/var/lib/opnix`, with secret files at mode `0600`. It invokes the pinned `nixos-anywhere` with `#srv-hatchi` and copies both through `--extra-files`. Bootstrap files remain root-owned; the `.config` tree uses UID 1000 and GID 100. The pre-switch check rejects a missing or empty token before bootloader installation, after disk formatting. A rejected token can therefore leave an erased machine without a bootable system.

Disko creates a 1 GiB EFI partition and an ext4 root filesystem on the SSD. It formats the HDD as ext4 and mounts it at `/srv`.

## Verify the installation

After `nixos-anywhere` reboots Hatchi:

1. Remove the installer USB and boot from the SSD.
2. Confirm that SSH works.
3. Confirm that `/srv` is the HDD:

   ```bash
   findmnt / /boot /srv
   lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS
   ```

4. Confirm that the host resolves as `srv-hatchi` before the first deployment.
5. Confirm that the provisioned secrets and application services started. Installation copies credentials from the prepared bundle; it does not generate them.

## Recover an interrupted deployment

If SSH is blocked, use Hatchi's local console. A Tailscale ping does not prove that TCP port 22 is allowed.

Inspect the running system and selected system profile:

```bash
readlink -f /run/current-system
readlink -f /nix/var/nix/profiles/system
ls -l /nix/var/nix/profiles/system-*-link
```

If the system profile points to the previous known-good generation, reactivate that generation:

```bash
sudo /nix/var/nix/profiles/system/bin/switch-to-configuration switch
```

This restarts affected services. It does not erase disks or application data. If the selected profile is not the known-good generation, stop and identify the correct generation first. Do not assume that rebooting selects the previous generation.

Verify SSH from the Mac before leaving the console:

```bash
ssh -o StrictHostKeyChecking=yes srv-hatchi hostname
```

## Provision secrets before deployment

The production configuration uses 1Password. It requires the service-account token on Hatchi before activation.

The prepared token is under `~/.local/state/hatchi-bootstrap` on the Mac. It is also backed up in the Homelab item `Hatchi production bootstrap`. Keep it private and outside the repository.

After recovering SSH, copy the token into a private staging directory:

```bash
ssh srv-hatchi 'install -d -m700 ~/hatchi-bootstrap'
scp ~/.local/state/hatchi-bootstrap/token srv-hatchi:~/hatchi-bootstrap/token
ssh -t srv-hatchi
```

On Hatchi, install the token with root ownership:

```bash
sudo install -d -m700 /var/lib/opnix
sudo install -o root -g root -m600 ~/hatchi-bootstrap/token /var/lib/opnix/token
```

Remove the temporary upload after confirming the installed file. Retain the protected backup in 1Password. Never display the token in terminal logs or paste it into chat.

## The runner's access token

The GitHub runner on Hatchi evaluates this flake, and the flake reads a private input, so the runner needs a read-only token for `dotfiles-private`. It is a 1Password item, delivered by opnix like the application secrets, and never stored in the bootstrap bundle or in Git.

At activation, `hatchi-runner-credential` renders it into `/etc/nix/runner-access-tokens.conf`, mode `0640`, group `github-runner`, and `nix.extraOptions` pulls that file in with `!include`. The `!` matters: plain `include` treats a missing file as an error, which would stop every Nix command on the host, including the rebuild that would restore it.

Rotation is an edit to the 1Password item followed by a re-activation. The unit fails loudly when the secret is empty, and it refuses to start the runner without it.

From the Mac, check the deployment before switching:

```bash
traitor deploy srv-hatchi --remote-build --dry-run
```

The pre-switch check reads the token file without installing secrets. The pinned deploy-rs ignores the activation script's failure status in dry-activation mode, so exit zero does not prove these checks passed. Inspect the diagnostics and resolve any reported failure before a real deployment. Real activation still rejects failed pre-switch checks.

A dry run does not prove application startup or automatic rollback. Confirm that Hatchi actually receives the address the private input declares as the DNS answer; that answer does not assign the address to an interface. Keep console access available during the first real deployment, particularly when the previous generation was not installed with deploy-rs.

The generation that first contains the deployment account must be activated by a credential that already exists on the host. Run that first activation as root over SSH from the Mac:

```bash
ssh root@srv-hatchi 'nixos-rebuild switch --flake "path:/home/dkumlin/.config/dotfiles#srv-hatchi"'
```

The `path:` prefix is required. Without it, Nix reads the checkout as a Git repository through libgit2, which refuses a repository owned by another user, so a root rebuild cannot evaluate a checkout owned by `dkumlin`.

After that generation is running, `traitor deploy srv-hatchi --remote-build` and CI both authenticate as the deployment account with no password.
