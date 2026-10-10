{
  config,
  pkgs,
  ...
}:

let
  palette = config.my.theme.palette;
in
{
  stylix = {
    enable = true;

    # The carrier is chosen per palette so that Stylix's `colors.slug` and
    # `colors.scheme-name` name the theme that is actually selected. Every base16
    # slot is then overridden, because the palette is more precise than the
    # scheme file.
    base16Scheme = "${pkgs.base16-schemes}/share/themes/${palette.scheme}.yaml";
    polarity = palette.mode;

    override = {
      base00 = palette.background;
      base01 = palette.lighter_background;
      base02 = palette.selection;
      base03 = palette.muted;
      base04 = palette.dark_foreground;
      base05 = palette.foreground;
      base06 = palette.light_foreground;
      base07 = palette.bright_foreground;
      base08 = palette.red;
      base09 = palette.orange;
      base0A = palette.yellow;
      base0B = palette.green;
      base0C = palette.cyan;
      base0D = palette.accent;
      base0E = palette.magenta;
      base0F = palette.brown;
    };

    fonts = {
      monospace = {
        name = "JetBrainsMono Nerd Font Mono";
        package = pkgs.nerd-fonts.jetbrains-mono;
      };
      sizes.terminal = 14;
    };
  };
}
