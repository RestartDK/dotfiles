{
  config,
  lib,
  pkgs,
  ...
}:

{
  # Imported by every host that runs Stylix. This is where a target Stylix owns by
  # default is turned off or handed to something else.
  stylix.targets = {
    # The runtime renderer owns these three, and Neovim renders through its own
    # colorscheme plugin.
    btop.enable = false;
    ghostty.colors.enable = false;
    neovim.enable = false;
    starship.enable = false;

    # The GNOME target is inert on the system side, which Stylix gates on GNOME or
    # GDM being enabled, but its Home Manager side always writes
    # `themes/Stylix/gnome-shell/gnome-shell.css`, and that basename trips the data
    # file assertion in tests/srv-nana/policy.nix.
    gnome.enable = false;

    # Waybar is awaiting a replacement decision.
    waybar.enable = false;
  };

  programs.ghostty.settings.theme = "live";
  programs.btop.settings.color_theme = "live";

  # macOS has no Stylix wallpaper target; desktoppr is the declarative route.
  programs.desktoppr = lib.mkIf (pkgs.stdenv.hostPlatform.isDarwin && config.stylix.image != null) {
    enable = true;
    settings.picture = config.stylix.image;
  };
}
