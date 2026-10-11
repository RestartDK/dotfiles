{
  config,
  lib,
  pkgs,
  ...
}:

{
  # Imported only by hosts that run Stylix. These option paths cannot live behind
  # a `lib.mkIf` in a shared module, because a disabled definition still
  # references them and a host without Stylix has no `stylix` option at all.
  stylix.targets = {
    btop.enable = false;
    ghostty.colors.enable = false;
    starship.enable = false;
  };

  programs.ghostty.settings.theme = "live";
  programs.btop.settings.color_theme = "live";

  # macOS has no Stylix wallpaper target; desktoppr is the declarative route.
  programs.desktoppr = lib.mkIf (pkgs.stdenv.hostPlatform.isDarwin && config.stylix.image != null) {
    enable = true;
    settings.picture = config.stylix.image;
  };
}
