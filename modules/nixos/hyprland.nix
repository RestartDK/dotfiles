{ pkgs, ... }:

{
  programs.hyprland = {
    enable = true;
    xwayland.enable = true;
  };

  programs.hyprlock.enable = true;

  # Prefer native Wayland for Electron/Chromium apps on NixOS.
  environment.sessionVariables.NIXOS_OZONE_WL = "1";

  fonts.packages = with pkgs; [
    nerd-fonts.symbols-only
  ];

  environment.systemPackages = with pkgs; [
    ghostty
    waybar
    wl-clipboard
    playerctl
    brightnessctl
    hyprlauncher
    hyprshutdown
    hyprpaper
    hyprpicker
    hyprsunset
    hyprcursor
    hyprland-qt-support
    hyprland-qtutils
    hyprpwcenter
    hyprsysteminfo
    networkmanagerapplet
    wlogout
    hyprpolkitagent
  ];

  # Hyprland is a compositor, not a full desktop environment. Keep an auth
  # agent available for privileged GUI prompts outside GNOME.
  systemd.user.services.hyprpolkitagent = {
    description = "Hyprland polkit authentication agent";
    wantedBy = [ "graphical-session.target" ];
    partOf = [ "graphical-session.target" ];
    after = [ "graphical-session.target" ];
    serviceConfig = {
      ExecStart = "${pkgs.hyprpolkitagent}/libexec/hyprpolkitagent";
      Restart = "on-failure";
    };
  };
}
