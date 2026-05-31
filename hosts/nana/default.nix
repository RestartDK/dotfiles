{ ... }:

{
  imports = [
    ./hardware-configuration.nix
    ../../modules/nixos/base.nix
    ../../modules/nixos/desktop-gnome.nix
    ../../modules/nixos/ssh.nix
    ../../modules/nixos/tailscale.nix
    ../../modules/nixos/docker.nix
    ../../modules/nixos/apps.nix
  ];

  boot.loader.grub = {
    enable = true;
    devices = [ "/dev/nvme0n1" ];
    useOSProber = true;
  };

  networking.hostName = "srv-nana";
  system.stateVersion = "26.05";
}
