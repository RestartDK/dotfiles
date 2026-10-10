{
  config,
  lib,
  pkgs,
  ...
}:

let
  theme = config.my.theme;

  # The runtime renderer reads these files, so Nix stays the source of the
  # values while the mode stays a runtime decision.
  paletteFile =
    name: palette:
    lib.concatLines (
      [
        "mode=${palette.mode}"
        "family=${palette.family}"
        "scheme=${palette.scheme}"
      ]
      ++ lib.optional (builtins.hasAttr name theme.backgrounds) "background_image=${
        toString theme.backgrounds.${name}
      }"
      ++ lib.mapAttrsToList (role: value: "${role}=${value}") (
        lib.removeAttrs palette [
          "mode"
          "family"
          "scheme"
        ]
      )
    );
in
{
  options.my.theme.runtime = {
    light = lib.mkOption {
      type = lib.types.str;
      default = "tokyo-day";
      description = "Palette rendered while the runtime mode is light.";
    };

    dark = lib.mkOption {
      type = lib.types.str;
      default = "tokyo-dark";
      description = "Palette rendered while the runtime mode is dark.";
    };
  };

  config = lib.mkIf theme.stylixDriven {
    assertions = [
      {
        assertion =
          builtins.hasAttr theme.runtime.light theme.palettes
          && builtins.hasAttr theme.runtime.dark theme.palettes;
        message = "my.theme.runtime must name entries of my.theme.palettes";
      }
    ];

    xdg.configFile."theme" = {
      source = ../../../config/theme;
      recursive = true;
      force = true;
    };

    xdg.dataFile = lib.mkMerge [
      {
        "theme/modes".text = ''
          dark ${theme.runtime.dark}
          light ${theme.runtime.light}
        '';

        # The static half of the starship config, which the renderer prepends to
        # its palette table.
        "theme/starship-base.toml".source =
          (pkgs.formats.toml { }).generate "starship-base"
            config.programs.starship.settings;
      }
      (lib.mapAttrs' (
        name: palette: lib.nameValuePair "theme/palettes/${name}" { text = paletteFile name palette; }
      ) theme.palettes)
    ];

    # A store path is needed on PATH, and the implementation stays live-editable
    # at ~/.config/theme/render.
    home.packages = [
      (pkgs.writeShellScriptBin "theme" ''
        exec "''${XDG_CONFIG_HOME:-$HOME/.config}/theme/render" "$@"
      '')
    ];

    # The renderer owns these files, so Stylix stops writing them while keeping
    # the fonts and everything else it covers.
    stylix.targets.ghostty.colors.enable = false;
    stylix.targets.btop.enable = false;
    stylix.targets.starship.enable = false;

    programs.ghostty.settings.theme = "live";
    programs.btop.settings.color_theme = "live";

    # macOS has no Stylix wallpaper target; desktoppr is the declarative route.
    programs.desktoppr = lib.mkIf (pkgs.stdenv.hostPlatform.isDarwin && config.stylix.image != null) {
      enable = true;
      settings.picture = config.stylix.image;
    };
  };
}
