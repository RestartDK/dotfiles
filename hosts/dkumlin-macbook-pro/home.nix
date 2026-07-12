{ ... }:

{
  imports = [
    ../../modules/home/dev-packages.nix
    ../../modules/home/live-symlinks.nix
  ];

  home.username = "danielkumlin";
  home.homeDirectory = "/Users/danielkumlin";
  home.stateVersion = "26.05";

  my.liveConfig = {
    enable = true;
    repoRoot = "/Users/danielkumlin/.config/dotfiles";
    groups = {
      shell = true;
      git = true;
      editors = true;
      terminalTools = true;
      ghostty = true;
      herdr = true;
      agents = true;
      macos = true;
    };
  };
}
