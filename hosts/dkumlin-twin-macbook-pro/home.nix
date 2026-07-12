{ inputs, ... }:

{
  imports = [
    inputs.hunk.homeManagerModules.default
    ../../modules/home/cobb-forwarding.nix
    ../../modules/home/dev-packages.nix
    ../../modules/home/live-symlinks.nix
  ];

  home.username = "danielkumlin";
  home.homeDirectory = "/Users/danielkumlin";
  home.stateVersion = "26.05";

  programs.hunk.enable = true;

  my.liveConfig = {
    enable = true;
    repoRoot = "/Users/danielkumlin/.config/dotfiles";
    piSettingsFile = "config/pi/agent/settings-twin.json";
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
