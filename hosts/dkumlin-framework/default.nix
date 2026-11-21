{
  config,
  inputs,
  lib,
  network,
  ...
}:

{
  imports = [
    inputs.nixos-hardware.nixosModules.framework-intel-core-ultra-series3
    inputs.disko.nixosModules.disko
    inputs.opnix.nixosModules.default
    (import ../../profiles/personal-secrets.nix { userName = "dkumlin"; })
    ./disk-layout.nix
    ./hardware-configuration.nix
    ../../modules/nixos/base.nix
    ../../modules/nixos/network.nix
    ../../modules/nixos/private.nix
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
    ../../modules/nixos/home-row-mods.nix
  ];

  my.theme.active = "tokyo-dark";

  my.host = {
    hostName = "dkumlin-framework";
    userName = "dkumlin";
    uid = 1000;
    homeDirectory = "/home/dkumlin";
  };

  my.secrets.keys.homelabSshKey = {
    reference = network.personalSecretReferences.homelabSshKey;
    path = "/run/onepassword-ssh/id_ed25519";
  };

  my.secrets.keys.mangyApiKey = {
    reference = network.personalSecretReferences.mangyApiKey;
    path = "${config.my.host.homeDirectory}/.opnix-mangy-api-key";
  };

  services.onepassword-secrets.systemdIntegration.enable = false;

  # base.nix keeps the servers awake for remote setup. A laptop has to suspend
  # when the lid closes.
  systemd.sleep.settings.Sleep.AllowSuspend = lib.mkForce "yes";

  # Framework recommends power-profiles-daemon over TLP; enabling it turns off
  # the TLP default from nixos-hardware. UPower reports the battery.
  services.power-profiles-daemon.enable = true;
  services.upower.enable = true;

  zramSwap.enable = true;

  system.stateVersion = "26.05";
}
