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

Before erasing disks, prepare the private bundle at `~/.local/state/hatchi-bootstrap/var/lib/sops` with `srv-hatchi.yaml` and `age/keys.txt`. The installer refuses missing or empty files. The bundle must contain the encrypted production service-account token and its age key, not the public test fixtures.

From the clean `main` checkout on the Mac, run:

```bash
traitor install srv-hatchi root@<HATCHI_IP> --confirm-destroy
```

`traitor install` accepts no additional installer options. It checks the configured disk identifiers, branch, upstream revision, hardware facts, working tree, and presence of the bootstrap files. It stages the clone at `/home/dkumlin/.config/dotfiles` and the bootstrap at `/var/lib/sops`, with secret files at mode `0600`. It invokes the pinned `nixos-anywhere` with `#srv-hatchi` and copies both through `--extra-files`. Bootstrap files remain root-owned; the `.config` tree uses UID 1000 and GID 100. The pre-switch check validates decryption before bootloader installation.

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

The production configuration uses 1Password. It requires an encrypted service-account token and the corresponding age key on Hatchi before activation.

The prepared bundle is under `~/.local/state/hatchi-bootstrap/var/lib/sops` on the Mac. The token and age key are also backed up in the Homelab item `Hatchi production bootstrap`. Keep the bundle private and outside the repository.

After recovering SSH, copy the bundle into a private staging directory:

```bash
ssh srv-hatchi 'install -d -m700 ~/hatchi-bootstrap'
scp -r ~/.local/state/hatchi-bootstrap/var/lib/sops srv-hatchi:~/hatchi-bootstrap/
ssh -t srv-hatchi
```

On Hatchi, install the files with root ownership:

```bash
sudo install -d -m700 /var/lib/sops/age
sudo install -o root -g root -m600 ~/hatchi-bootstrap/sops/srv-hatchi.yaml /var/lib/sops/srv-hatchi.yaml
sudo install -o root -g root -m600 ~/hatchi-bootstrap/sops/age/keys.txt /var/lib/sops/age/keys.txt
```

Remove the temporary upload after confirming both files were installed. Retain the protected backup in 1Password. Never display the token or age private key in terminal logs or paste them into chat.

From the Mac, check the deployment before switching:

```bash
traitor deploy srv-hatchi --remote-build --dry-run
```

The pre-switch check reads the manifest and decrypts the bootstrap without installing secrets. A successful dry run does not prove application startup or automatic rollback. Keep console access available during the first real deployment, particularly when the previous generation was not installed with deploy-rs.
