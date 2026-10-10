{ inputs, ... }:

{
  imports = [
    ./cache.nix
    inputs.opnix.nixosModules.default
    (import ../../profiles/personal-secrets.nix { userName = "dkumlin"; })
    ./hardware-configuration.nix
    ../../modules/nixos/base.nix
    ../../modules/nixos/network.nix
    ../../modules/nixos/private.nix
    ../../modules/nixos/deploy.nix
    ../../modules/nixos/secrets.nix
    ../../modules/nixos/numtide-cache.nix
    ../../modules/nixos/desktop.nix
    ../../modules/nixos/hyprland.nix
    ../../modules/theme/options.nix
    ../../modules/theme/system.nix
    ../../modules/nixos/ssh.nix
    ../../modules/nixos/tailscale.nix
    ../../modules/nixos/docker.nix
    ../../modules/nixos/apps.nix
    ../../modules/nixos/nvidia.nix
    ../../modules/nixos/rustdesk.nix
  ];

  my.theme.active = "tokyo-dark";

  stylix.image = ../../config/hypr/wallpapers/current.png;

  my.host = {
    hostName = "srv-nana";
    userName = "dkumlin";
    uid = 1000;
    homeDirectory = "/home/dkumlin";
  };

  users.users.dkumlin = {
    linger = true;
    openssh.authorizedKeys.keyFiles = [
      ../../config/ssh/public-keys/nana.pub
    ];
  };

  boot.loader.grub = {
    enable = true;
    devices = [ "/dev/nvme0n1" ];
    useOSProber = true;
  };

  services.onepassword-secrets.systemdIntegration.enable = false;

  system.stateVersion = "26.05";
}
