{
  config,
  dotfilesInputs,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.liveConfig;
  herdrPackage = dotfilesInputs.self.packages.${pkgs.stdenv.hostPlatform.system}.herdr;
  tuicrPackage = dotfilesInputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.tuicr;
in
{
  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf cfg.groups.terminalTools {
        home.packages = [ tuicrPackage ];
        programs.btop = {
          enable = true;
          # Stylix owns the theme wherever the palette drives the host.
          settings = lib.mkMerge [
            {
              vim_keys = true;
              proc_sorting = "memory";
            }
            (lib.mkIf (!config.my.theme.stylixDriven) { color_theme = "TTY"; })
          ];
        };
        xdg.configFile = {
          "thefuck/settings.py" = {
            source = ../../../config/thefuck/settings.py;
            force = true;
          };
          "tuicr/config.toml" = {
            source = ../../../config/tuicr/config.toml;
            force = true;
          };
        };
      })

      (lib.mkIf cfg.groups.ghostty {
        programs.ghostty = {
          enable = true;
          # macOS gets Ghostty from the Homebrew cask; pkgs.ghostty is
          # Linux-only and refuses to evaluate on darwin.
          package = lib.mkIf pkgs.stdenv.hostPlatform.isDarwin null;
          # Stylix owns the theme, font and size on the Wayland desktop.
          settings = lib.mkMerge [
            {
              shell-integration = "zsh";
              desktop-notifications = true;
              clipboard-read = "allow";
              clipboard-write = "allow";
              cursor-style-blink = false;
              window-padding-x = 8;
              window-padding-y = 6;
              window-padding-balance = true;
              window-save-state = "always";
              keybind = [
                "super+r=reload_config"
                "command+shift+p=toggle_command_palette"
              ];
            }
            (lib.mkIf (!config.my.theme.stylixDriven) {
              theme = "dark:TokyoNight,light:TokyoNight Day";
              font-family = "JetBrainsMono Nerd Font Mono";
              font-size = 14;
            })
          ];
        };
      })

      (lib.mkIf cfg.groups.multiplexer {
        home.packages = [ herdrPackage ];
        xdg.configFile = {
          "herdr/config.toml" = {
            source = ../../../config/herdr/config.toml;
            force = true;
          };
          "herdr/hostname-status.py" = {
            source = ../../../config/herdr/hostname-status.py;
            force = true;
          };
          "herdr/sounds/haki.mp3" = {
            source = ../../../config/herdr/sounds/haki.mp3;
            force = true;
          };
          "herdr/sounds/za-warudo.mp3" = {
            source = ../../../config/herdr/sounds/za-warudo.mp3;
            force = true;
          };
        };
      })
    ]
  );
}
