{ ... }:

{
  imports = [
    ../../modules/home/dev-packages.nix
    ../../modules/home/live-symlinks.nix
  ];

  home.username = "dkumlin";
  home.homeDirectory = "/home/dkumlin";
  home.stateVersion = "26.05";

  my.liveConfig = {
    enable = true;
    repoRoot = "/home/dkumlin/Projects/nixos-config";
    codexConfigPath = "dotfiles/codex/srv-nana/.codex/config.toml";
    groups = {
      shell = true;
      git = true;
      editors = true;
      terminalTools = true;
      herdr = true;
      agents = true;
    };
  };
}
