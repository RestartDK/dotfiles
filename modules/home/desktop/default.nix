{ config, lib, ... }:

let
  cfg = config.my.liveConfig;
  link = path: config.lib.file.mkOutOfStoreSymlink "${cfg.repoRoot}/${path}";
  file = path: {
    source = link path;
    force = true;
  };
  dir = path: {
    source = link path;
    recursive = false;
    force = true;
  };
in
{
  config = lib.mkIf cfg.enable (lib.mkMerge [
    (lib.mkIf cfg.groups.wayland {
      xdg.configFile."hypr" = dir "config/hypr";
      xdg.configFile."waybar" = dir "config/waybar";
      xdg.configFile."wlogout" = dir "config/wlogout";
      # Hyprtoolkit/Hyprlauncher only search ~/.local/share/icons and
      # /usr/share/icons, not NixOS' /run/current-system/sw/share/icons.
      home.file.".local/share/icons/hicolor" = {
        source = config.lib.file.mkOutOfStoreSymlink "/run/current-system/sw/share/icons/hicolor";
        force = true;
      };
      home.file.".local/share/icons/Papirus" = {
        source = config.lib.file.mkOutOfStoreSymlink "/run/current-system/sw/share/icons/Papirus";
        force = true;
      };
      home.file.".local/share/icons/breeze" = {
        source = config.lib.file.mkOutOfStoreSymlink "/run/current-system/sw/share/icons/breeze";
        force = true;
      };
    })

    (lib.mkIf cfg.groups.macos {
      home.file.".hammerspoon/init.lua" = file "config/hammerspoon/init.lua";
      xdg.configFile."aerospace/aerospace.toml" = file "config/aerospace/aerospace.toml";
      xdg.configFile."karabiner/karabiner.json" = file "config/karabiner/karabiner.json";
      xdg.configFile."graphite/aliases" = file "config/graphite/aliases";
      xdg.configFile."sketchybar" = dir "config/sketchybar";
      xdg.configFile."wezterm/wezterm.lua" = file "config/wezterm/wezterm.lua";
      xdg.configFile."amp" = dir "config/amp";
      xdg.configFile."cmux/cmux.json" = file "config/cmux/cmux.json";
    })
  ]);
}
