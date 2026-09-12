{ config, osConfig, ... }:
{
  imports = [
    ../../modules/home/dev-packages.nix
    ../../modules/home/live-symlinks.nix
  ];

  home = {
    username = osConfig.my.host.userName;
    homeDirectory = osConfig.my.host.homeDirectory;
    stateVersion = "26.05";
  };

  my.liveConfig = {
    enable = true;
    repoRoot = "${config.home.homeDirectory}/.config/dotfiles";
    groups = {
      shell = true;
      git = true;
      editors = true;
      terminalTools = true;
      multiplexer = true;
      agents = true;
    };
  };
}
