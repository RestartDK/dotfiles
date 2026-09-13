{
  config,
  lib,
  pkgs,
  ...
}:
let
  hatchiPublicKey = lib.strings.trim (builtins.readFile ../../config/ssh/public-keys/hatchi.pub);
in
{
  imports = [
    ../../modules/nixos/host-options.nix
    ../../modules/nixos/ssh.nix
    ../../modules/nixos/numtide-cache.nix
  ];
  my.host = {
    hostName = "srv-hatchi";
    uid = 1000;
    extraGroups = [ "wheel" ];
  };
  users.users.${config.my.host.userName} = {
    isNormalUser = true;
    inherit (config.my.host) extraGroups uid;
    openssh.authorizedKeys.keys = config.my.host.authorizedKeys ++ [ hatchiPublicKey ];
  };
  users.users.root.openssh.authorizedKeys.keys = config.my.host.rootAuthorizedKeys ++ [
    hatchiPublicKey
  ];
  services.openssh.openFirewall = false;
  services.tailscale = {
    enable = true;
    openFirewall = false;
    extraSetFlags = [ "--netfilter-mode=off" ];
  };
  virtualisation.docker.enable = false;
  virtualisation.podman.enable = false;
  services.cockpit.enable = false;
  environment.systemPackages = [
    pkgs.curl
    pkgs.jq
  ];
  nix = {
    settings = {
      auto-optimise-store = true;
      experimental-features = [
        "nix-command"
        "flakes"
      ];
    };
    gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 14d";
    };
  };
  services = {
    fstrim.enable = true;
    journald.extraConfig = "SystemMaxUse=2G";
  };
  zramSwap.enable = true;
  system.stateVersion = "26.05";
}
