{ pkgs, ... }:

{
  imports = [
    ../../modules/home/cobb-forwarding.nix
    ../../modules/home/dev-packages.nix
    ../../modules/home/groups.nix
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

  my.ai.profile = "personal";

  my.liveConfig = {
    enable = true;
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
