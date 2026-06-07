{ ... }:

{
  imports = [
    ./hardware-configuration.nix
    ../../modules/nixos/base.nix
    ../../modules/nixos/desktop-gnome.nix
    ../../modules/nixos/hyprland.nix
    ../../modules/nixos/ssh.nix
    ../../modules/nixos/tailscale.nix
    ../../modules/nixos/docker.nix
    ../../modules/nixos/apps.nix
    ../../modules/nixos/nvidia.nix
    ../../modules/nixos/rustdesk.nix
  ];

  boot.loader.grub = {
    enable = true;
    devices = [ "/dev/nvme0n1" ];
    useOSProber = true;
  };

  networking.hostName = "srv-nana";
  system.stateVersion = "26.05";
}
