{ config, lib, ... }:

let
  cfg = config.my.liveConfig;
in
{
  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf cfg.groups.wayland {
        xdg.configFile = {
          "hypr" = {
            source = ../../../config/hypr;
            recursive = true;
            force = true;
          };
          "waybar" = {
            source = ../../../config/waybar;
            recursive = true;
            force = true;
          };
          "wlogout" = {
            source = ../../../config/wlogout;
            recursive = true;
            force = true;
          };
        };
        # Hyprtoolkit/Hyprlauncher only search ~/.local/share/icons and
        # /usr/share/icons, not NixOS' /run/current-system/sw/share/icons.
        home.file = {
          ".local/share/icons/hicolor" = {
            source = config.lib.file.mkOutOfStoreSymlink "/run/current-system/sw/share/icons/hicolor";
            force = true;
          };
          ".local/share/icons/Papirus" = {
            source = config.lib.file.mkOutOfStoreSymlink "/run/current-system/sw/share/icons/Papirus";
            force = true;
          };
          ".local/share/icons/breeze" = {
            source = config.lib.file.mkOutOfStoreSymlink "/run/current-system/sw/share/icons/breeze";
            force = true;
          };
        };
      })

      (lib.mkIf cfg.groups.macos {
        home.file.".hammerspoon/init.lua" = {
          source = ../../../config/hammerspoon/init.lua;
          force = true;
        };
        xdg.configFile = {
          "aerospace/aerospace.toml" = {
            source = ../../../config/aerospace/aerospace.toml;
            force = true;
          };
          "graphite/aliases" = {
            source = ../../../config/graphite/aliases;
            force = true;
          };
          "sketchybar" = {
            source = ../../../config/sketchybar;
            recursive = true;
            force = true;
          };
          "wezterm/wezterm.lua" = {
            source = ../../../config/wezterm/wezterm.lua;
            force = true;
          };
          "amp" = {
            source = ../../../config/amp;
            recursive = true;
            force = true;
          };
          "cmux/cmux.json" = {
            source = ../../../config/cmux/cmux.json;
            force = true;
          };
        };
      })
    ]
  );
}
