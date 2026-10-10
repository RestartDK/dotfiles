{
  config,
  lib,
  options,
  ...
}:

let
  hexColor = lib.types.strMatching "#[0-9a-fA-F]{6}";

  color = lib.mkOption { type = hexColor; };

  roles = [
    "accent"
    "selection"
    "muted"
    "background"
    "dark_background"
    "darker_background"
    "lighter_background"
    "foreground"
    "dark_foreground"
    "light_foreground"
    "bright_foreground"
    "red"
    "orange"
    "yellow"
    "green"
    "cyan"
    "blue"
    "magenta"
    "brown"
    "bright_red"
    "bright_yellow"
    "bright_green"
    "bright_cyan"
    "bright_blue"
    "bright_magenta"
  ];

  paletteType = lib.types.submodule {
    options = {
      mode = lib.mkOption {
        type = lib.types.enum [
          "dark"
          "light"
        ];
      };
      family = lib.mkOption {
        type = lib.types.strMatching "[a-z][a-z0-9-]*";
        description = "Upstream project the palette is drawn from. Apps that consume named themes map from this.";
      };
      scheme = lib.mkOption {
        type = lib.types.strMatching "[a-z0-9][a-z0-9-]*";
        description = ''
          Filename of the published Tinted Theming scheme that best matches this
          palette, without the extension. The values come from this palette, not
          from that file; the name exists so Stylix can carry it through as
          `colors.slug` and `colors.scheme-name`, which targets such as zed and
          fish use to name the theme.
        '';
      };
    }
    // lib.genAttrs roles (_: color);
  };
in
{
  options.my.theme = {
    active = lib.mkOption {
      type = lib.types.enum (builtins.attrNames config.my.theme.palettes);
      default = "tokyo-dark";
      description = "The entry of `my.theme.palettes` this host renders from.";
    };

    palettes = lib.mkOption {
      type = lib.types.attrsOf paletteType;
      default = {
        tokyo-dark = import ./palettes/tokyo-dark.nix;
        tokyo-day = import ./palettes/tokyo-day.nix;
        catppuccin-mocha = import ./palettes/catppuccin-mocha.nix;
        catppuccin-latte = import ./palettes/catppuccin-latte.nix;
      };
      description = "Named colour sets. Add one here to make it selectable everywhere.";
    };

    palette = lib.mkOption {
      type = paletteType;
      readOnly = true;
      description = "The resolved palette. Consumers read roles from here.";
    };

    stylixDriven = lib.mkOption {
      type = lib.types.bool;
      readOnly = true;
      description = "Whether Stylix renders this host from the palette. Derived, never set.";
    };
  };

  config = {
    my.theme.palette = config.my.theme.palettes.${config.my.theme.active};
    my.theme.stylixDriven = (options ? stylix) && config.stylix.enable;
  };
}
