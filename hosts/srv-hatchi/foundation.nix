{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
let
  hatchiPublicKey = lib.strings.trim (builtins.readFile ../../config/ssh/public-keys/hatchi.pub);
in
{
  imports = [
    inputs.home-manager.nixosModules.home-manager
    ../../modules/nixos/host-options.nix
    ../../modules/nixos/ssh.nix
    ../../modules/nixos/numtide-cache.nix
  ];
  my.host = {
    hostName = "srv-hatchi";
    uid = 1000;
    extraGroups = [ "wheel" ];
  };
  programs.zsh.enable = true;
  users.users.${config.my.host.userName} = {
    isNormalUser = true;
    inherit (config.my.host) extraGroups uid;
    home = config.my.host.homeDirectory;
    shell = pkgs.zsh;
    openssh.authorizedKeys.keys = config.my.host.authorizedKeys ++ [ hatchiPublicKey ];
  };
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    backupFileExtension = "hm-backup";
    extraSpecialArgs = {
      inherit inputs;
      dotfilesInputs = inputs;
    };
    users.${config.my.host.userName} = import ./home.nix;
  };
  users.users.root.openssh.authorizedKeys.keys = config.my.host.rootAuthorizedKeys ++ [
    hatchiPublicKey
  ];
  networking.nameservers = [
    "1.1.1.1"
    "9.9.9.9"
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
    logind.settings.Login = {
      HandleLidSwitch = "ignore";
      HandleLidSwitchDocked = "ignore";
      HandleLidSwitchExternalPower = "ignore";
    };
  };
  systemd.sleep.settings.Sleep = {
    AllowSuspend = "no";
    AllowHibernation = "no";
    AllowHybridSleep = "no";
    AllowSuspendThenHibernate = "no";
  };
  zramSwap.enable = true;
  system.stateVersion = "26.05";
}
