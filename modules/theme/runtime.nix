{
  config,
  lib,
  pkgs,
  ...
}:

let
  theme = config.my.theme;

  # Neovim cannot enumerate a plugin's variants, and the two plugins disagree on
  # both the option name and the value set, so the mapping lives here and is
  # rendered into the palette file. Neovim then needs no table of its own.
  nvimSchemes = {
    tokyo = {
      plugin = "tokyonight";
      option = "style";
      dark = "night";
      light = "day";
    };
    catppuccin = {
      plugin = "catppuccin";
      option = "flavour";
      dark = "mocha";
      light = "latte";
    };
  };

  # The runtime renderer reads these files, so Nix stays the source of the
  # values while the mode stays a runtime decision.
  paletteFile =
    palette:
    lib.concatLines (
      [
        "mode=${palette.mode}"
        "family=${palette.family}"
        "scheme=${palette.scheme}"
        "nvim_plugin=${nvimSchemes.${palette.family}.plugin}"
        "nvim_option=${nvimSchemes.${palette.family}.option}"
        "nvim_variant=${nvimSchemes.${palette.family}.${palette.mode}}"
      ]
      ++ lib.optional (palette.wallpaper != null) "background_image=${toString palette.wallpaper}"
      ++ lib.mapAttrsToList (role: value: "${role}=${value}") (
        lib.removeAttrs palette [
          "mode"
          "family"
          "scheme"
          "wallpaper"
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
      source = ../../config/theme;
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
        # its palette table. `palette` is a root key, so it has to live here,
        # where the TOML generator emits it ahead of every table.
        "theme/starship-base.toml".source = (pkgs.formats.toml { }).generate "starship-base" (
          config.programs.starship.settings // { palette = "base16"; }
        );
      }
      (lib.mapAttrs' (
        name: palette: lib.nameValuePair "theme/palettes/${name}" { text = paletteFile palette; }
      ) theme.palettes)
    ];

    # The renderer writes the starship config from the palette, so Home Manager
    # must not link its own copy over it. `programs.starship.settings` still
    # feeds the generated base.
    home.file."${config.programs.starship.configPath}".enable = lib.mkForce false;

    # A store path is needed on PATH, and the implementation stays live-editable
    # at ~/.config/theme/render. The renderer moves the macOS picture through
    # desktoppr on PATH, and the launchd observer gets it from its own PATH, so
    # the interactive shell needs the package too.
    home.packages = [
      (pkgs.writeShellScriptBin "theme" ''
        exec "''${XDG_CONFIG_HOME:-$HOME/.config}/theme/render" "$@"
      '')
    ]
    ++ lib.optionals pkgs.stdenv.hostPlatform.isDarwin [ pkgs.desktoppr ];
  };
}
