{
  config,
  lib,
  pkgs,
  ...
}:

let
  host = config.my.host;
in
{
  imports = [ ./host-options.nix ];

  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];
  nix.settings.auto-optimise-store = true;

  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 14d";
  };

  nixpkgs.config.allowUnfree = true;

  time.timeZone = "Europe/Paris";
  i18n.defaultLocale = "en_GB.UTF-8";
  i18n.extraLocaleSettings = {
    LC_ADDRESS = "fr_FR.UTF-8";
    LC_IDENTIFICATION = "fr_FR.UTF-8";
    LC_MEASUREMENT = "fr_FR.UTF-8";
    LC_MONETARY = "fr_FR.UTF-8";
    LC_NAME = "fr_FR.UTF-8";
    LC_NUMERIC = "fr_FR.UTF-8";
    LC_PAPER = "fr_FR.UTF-8";
    LC_TELEPHONE = "fr_FR.UTF-8";
    LC_TIME = "fr_FR.UTF-8";
  };

  networking.networkmanager.enable = true;
  networking.nameservers = [
    "1.1.1.1"
    "9.9.9.9"
  ];

  # Avoid remote setup being interrupted by desktop idle suspend.
  systemd.sleep.settings.Sleep = {
    AllowSuspend = "no";
    AllowHibernation = "no";
    AllowHybridSleep = "no";
    AllowSuspendThenHibernate = "no";
  };

  users.mutableUsers = true;
  users.users.${host.userName} = {
    isNormalUser = true;
    home = host.homeDirectory;
    description = host.fullName;
    shell = pkgs.zsh;
    inherit (host) extraGroups;
    openssh.authorizedKeys.keys = host.authorizedKeys;
  }
  // lib.optionalAttrs (host.uid != null) {
    inherit (host) uid;
  };

  # Break-glass root SSH access. Password login stays disabled; only these
  # public keys can log in as root.
  users.users.root.openssh.authorizedKeys.keys = host.rootAuthorizedKeys;

  programs.zsh.enable = true;
  programs.dconf.enable = true;

  environment.variables = {
    EDITOR = "nvim";
    VISUAL = "nvim";
  };
}
