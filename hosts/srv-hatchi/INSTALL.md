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

From the clean `main` checkout on the Mac, run:

```bash
traitor install srv-hatchi root@<HATCHI_IP> --confirm-destroy
```

`traitor install` accepts no additional installer options. It checks the configured disk identifiers, branch, upstream revision, hardware facts, and working tree. It then creates a temporary clone at `/home/dkumlin/.config/dotfiles`, invokes the pinned `nixos-anywhere` with `#srv-hatchi`, copies that clone with `--extra-files`, and sets the `.config` tree ownership to UID 1000 and GID 100.

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
