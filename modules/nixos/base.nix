{ pkgs, ... }:

{
  nix.settings.experimental-features = [ "nix-command" "flakes" ];
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

  # Avoid remote setup being interrupted by desktop idle suspend.
  systemd.sleep.settings.Sleep = {
    AllowSuspend = "no";
    AllowHibernation = "no";
    AllowHybridSleep = "no";
    AllowSuspendThenHibernate = "no";
  };

  users.mutableUsers = true;
  users.users.dkumlin = {
    isNormalUser = true;
    uid = 1000;
    home = "/home/dkumlin";
    description = "Daniel Kumlin";
    shell = pkgs.zsh;
    extraGroups = [ "wheel" "networkmanager" "docker" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGAxMdKa0tzi0uq+OhhWQslqaK5Jjnb7XFvnzlf83DQD danielkumlinwork@gmail.com"
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINP2i4TskZfwyLSApLt8FziTHNyO3/XMrCIndXWSQ04E dkumlin@192.168.200.182"
    ];
  };

  programs.zsh.enable = true;
  programs.dconf.enable = true;

  environment.variables = {
    EDITOR = "nvim";
    VISUAL = "nvim";
  };
}
