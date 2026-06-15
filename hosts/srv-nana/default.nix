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

  my.host = {
    hostName = "srv-nana";
    userName = "dkumlin";
    uid = 1000;
    homeDirectory = "/home/dkumlin";
  };

  boot.loader.grub = {
    enable = true;
    devices = [ "/dev/nvme0n1" ];
    useOSProber = true;
  };

  system.stateVersion = "26.05";
}
