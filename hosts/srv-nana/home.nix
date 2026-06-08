{ pkgs, ... }:

{
  imports = [
    ../../modules/home/dev-packages.nix
    ../../modules/home/live-symlinks.nix
  ];

  home.username = "dkumlin";
  home.homeDirectory = "/home/dkumlin";
  home.stateVersion = "26.05";

  gtk.enable = true;

  home.pointerCursor = {
    enable = true;
    package = pkgs.adwaita-icon-theme;
    name = "Adwaita";
    size = 24;
    gtk.enable = true;
    x11.enable = true;
    dotIcons.enable = true;
  };

  dconf.settings."org/gnome/desktop/interface" = {
    color-scheme = "prefer-dark";
    cursor-theme = "Adwaita";
    cursor-size = 24;
  };

  xdg.desktopEntries.hyprland-settings = {
    name = "Settings";
    genericName = "System Settings";
    comment = "Open GNOME Settings from Hyprland";
    exec = "settings";
    icon = "org.gnome.Settings";
    categories = [ "Settings" ];
  };

  my.liveConfig = {
    enable = true;
    repoRoot = "/home/dkumlin/Projects/nix-config";
    groups = {
      shell = true;
      git = true;
      editors = true;
      terminalTools = true;
      ghostty = true;
      wayland = true;
      herdr = true;
      agents = true;
    };
  };
}
