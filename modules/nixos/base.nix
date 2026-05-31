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


  # Break-glass root SSH access. Password login stays disabled; only these
  # public keys can log in as root.
  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGAxMdKa0tzi0uq+OhhWQslqaK5Jjnb7XFvnzlf83DQD danielkumlinwork@gmail.com"
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQCoxPQY9dhr7Xkq0Cwe6NO51EdYbFYTXVQwqtso75jq2PbKqeExh7+NWLQnI0JzxutczGzYGy6MSWnoQ2Ztaxzfsno6rrdsuxnI5PZCOKUn0ymC/gEBRMLfW0xKOGOgY+34k55L8kbVO0nvVYm79VoYqGo3m3htesff8cW9dLFwMqGjC3541BGCSeXTStMkFEARznInpIlmauwrsnB6x9xI10dy5fbGM4+74hk6wnAGHNzn3EgFiIRwvC+EyGnxTY89OPskKE6MBANRZJoUeOj2gPHqi1qimgyf9Z680G24Uflw9wZ2nDFxjpixb8J38efZNV1n0XqJT0IjnedNUOjIXb/6BzGycOSXR2X4X6OuMZ9iYx29sUHS3jO5SVbKPDFuf1om70oSVRLmXRK+s9ff4xzRh5S+IAg9mJ1aq5tZ8Tpx+o8mChJhb7nLNA2e7DdcgwfaoyDtVsxCtXdjqD57YNjHohSIHFfb/hFEtm2CVDGrqYL3VC+29U+Y28m80HsbCqDQG7004d7jx2+9ljoMn0Hz/aggltafe9hP0+Pe4bRqqU8btW9GVkQGdntc1otDEWgc1djaRj5/fvH1NbA/F3Dpgo6ljVMPapsNPAcc1cCAHr87XiPTHBj2HCzIGES6R9gz+HL8KjPtKrGkFmiVh9IpNHbylKDwL138dhKdfQ== root@192.168.200.182"
  ];

  programs.zsh.enable = true;
  programs.dconf.enable = true;

  environment.variables = {
    EDITOR = "nvim";
    VISUAL = "nvim";
  };
}
