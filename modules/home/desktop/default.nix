{
  config,
  lib,
  osConfig ? null,
  pkgs,
  ...
}:

let
  cfg = config.my.liveConfig;
in
{
  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf cfg.groups.wayland {
        xdg.configFile = {
          "hypr/hypridle.conf" = {
            source = ../../../config/hypr/hypridle.conf;
            force = true;
          };
          "hypr/hyprlauncher.conf" = {
            source = ../../../config/hypr/hyprlauncher.conf;
            force = true;
          };
          "hypr/hyprtoolkit.conf" = {
            source = ../../../config/hypr/hyprtoolkit.conf;
            force = true;
          };
          "hypr/scripts" = {
            source = ../../../config/hypr/scripts;
            recursive = true;
            force = true;
          };
          "hypr/wallpapers" = {
            source = ../../../config/hypr/wallpapers;
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
        # The hicolor fallback theme is the merged tree in the system profile,
        # which carries every app's own icons; the package has only the theme
        # skeleton and would drop them.
        home.file = {
          ".local/share/icons/hicolor" = {
            source = "${osConfig.system.path}/share/icons/hicolor";
            force = true;
          };
          ".local/share/icons/Papirus" = {
            source = "${pkgs.papirus-icon-theme}/share/icons/Papirus";
            force = true;
          };
          ".local/share/icons/breeze" = {
            source = "${pkgs.kdePackages."breeze-icons"}/share/icons/breeze";
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
