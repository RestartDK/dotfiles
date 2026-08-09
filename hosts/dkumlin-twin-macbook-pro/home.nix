{ pkgs, ... }:

{
  imports = [
    ../../modules/home/cobb-forwarding.nix
    ../../modules/home/dev-packages.nix
    ../../modules/home/live-symlinks.nix
    ../../modules/home/ssh.nix
  ];

  home = {
    username = "danielkumlin";
    homeDirectory = "/Users/danielkumlin";
    stateVersion = "26.05";

    packages = with pkgs; [
      esp-generate
    ];
  };

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
      multiplexer = true;
      agents = true;
      macos = true;
    };
  };
}
