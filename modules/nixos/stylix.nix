{ pkgs, ... }:

{
  stylix = {
    enable = true;
    base16Scheme = "${pkgs.base16-schemes}/share/themes/tokyo-night-dark.yaml";
    image = ../../config/hypr/wallpapers/current.png;
    polarity = "dark";

    # tokyo-night-dark leaves the base16 error and urgent slots pointing at
    # blues, so take red and orange from the terminal variant of the same theme.
    override = {
      base08 = "f7768e";
      base09 = "ff9e64";
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
