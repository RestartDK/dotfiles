{ modulesPath, ... }:
{
  imports = [ (modulesPath + "/profiles/qemu-guest.nix") ];
  fileSystems."/" = {
    device = "/dev/disk/by-label/reference-root";
    fsType = "ext4";
  };
  boot.loader.grub.enable = false;
  system.nixos.tags = [ "uncommissioned-reference-only" ];
}
