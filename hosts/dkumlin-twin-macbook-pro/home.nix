{ config, pkgs, ... }:

{
  imports = [
    ../../modules/home/cobb-forwarding.nix
    ../../modules/home/dev-packages.nix
    ../../modules/home/groups.nix
    ../../modules/home/desktop/stylix.nix
    ../../modules/theme/macos-observer.nix
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

  # The Herdr app rewrites keys.json, settings.json and layouts while it runs,
  # so these stay live links into the checkout instead of store copies. force
  # replaces the app-written file at activation instead of backing it up.
  xdg.configFile = {
    "herdr-app/keys.json" = {
      source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/dotfiles/config/herdr-app/keys.json";
      force = true;
    };
    "herdr-app/settings.json" = {
      source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/dotfiles/config/herdr-app/settings.json";
      force = true;
    };
    "herdr-app/layouts/main-vim.json" = {
      source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/dotfiles/config/herdr-app/layouts/main-vim.json";
      force = true;
    };
    "herdr-app/sounds/haki.mp3" = {
      source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/dotfiles/config/herdr-app/sounds/haki.mp3";
      force = true;
    };
    "herdr-app/sounds/za-warudo.mp3" = {
      source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/dotfiles/config/herdr-app/sounds/za-warudo.mp3";
      force = true;
    };
  };

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
