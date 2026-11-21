# Install dkumlin-framework

This procedure erases the laptop's internal NVMe (`/dev/nvme0n1`). It runs `nixos-anywhere` from the Mac against the laptop while the laptop runs the NixOS installer from USB. The laptop builds the system itself, so the Mac needs no Linux builder.

## Prepare the installer USB

Any recent x86_64 NixOS ISO works, minimal or graphical. To write one from the Mac, find the stick first, then write the image to its raw device:

```bash
diskutil list external physical
diskutil unmountDisk /dev/diskN
sudo dd if=nixos-minimal-x86_64-linux.iso of=/dev/rdiskN bs=4m status=progress
```

## Boot the laptop

1. Power on and press F2 for the BIOS. Disable Secure Boot, which blocks the installer and systemd-boot.
2. Reboot with the USB inserted and press F12 to choose it.
3. Connect to the network. A USB-C Ethernet adapter needs no setup. On the graphical ISO, use the network applet. On the minimal ISO, use Wi-Fi:

   ```bash
   sudo systemctl start wpa_supplicant
   wpa_cli
   > add_network
   > set_network 0 ssid "<SSID>"
   > set_network 0 psk "<PASSWORD>"
   > enable_network 0
   > quit
   ```

4. Set a root password and find the address:

   ```bash
   sudo passwd root
   ip -br addr
   ```

5. From the Mac, confirm root access: `ssh-copy-id root@<IP>`, then `ssh root@<IP>`.

## Install NixOS

From this checkout on the Mac, run the following. The `read` prompt keeps the LUKS passphrase out of shell history and off disk.

```bash
read -rs "pass?LUKS passphrase: "; echo
nix run .#nixos-anywhere -- \
  --flake .#dkumlin-framework \
  --target-host root@<IP> \
  --build-on remote \
  --generate-hardware-config nixos-generate-config hosts/dkumlin-framework/hardware-configuration.nix \
  --disk-encryption-keys /tmp/disk.key <(printf '%s' "$pass")
unset pass
```

nixos-anywhere overwrites `hardware-configuration.nix` with the detected hardware, partitions the disk per `disk-layout.nix` (a 1 GiB ESP and a LUKS2 ext4 root), builds the system on the laptop, installs it, and reboots. Commit the generated `hardware-configuration.nix`.

## First boot

1. Remove the USB. Enter the LUKS passphrase at boot.
2. `dkumlin` has no password yet, so tuigreet cannot log in. Set one over SSH from the Mac, using the keys from the private input:

   ```bash
   ssh root@<IP> passwd dkumlin
   ```

3. Log in, then join Wi-Fi with `nmtui` if needed.
4. Provision the 1Password service-account token that opnix reads, then restart the secret service:

   ```bash
   sudo install -m 600 /dev/stdin /etc/opnix-token   # paste the token, then Ctrl-D
   sudo systemctl restart opnix-secrets
   ```

5. Clone the dotfiles to `~/.config/dotfiles`, where the live config links point, and rebuild:

   ```bash
   git clone https://github.com/RestartDK/dotfiles ~/.config/dotfiles
   cd ~/.config/dotfiles && traitor framework
   ```

6. Join the tailnet with `sudo tailscale up`, enroll a fingerprint with `fprintd-enroll`, and update the firmware with `fwupdmgr refresh && fwupdmgr update`.
