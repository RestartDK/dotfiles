{ pkgs, ... }:

let
  hyprlandSettings = pkgs.writeShellScriptBin "settings" ''
    export XDG_CURRENT_DESKTOP=GNOME
    exec ${pkgs.gnome-control-center}/bin/gnome-control-center "$@"
  '';
in
{
  programs.hyprland = {
    enable = true;
    xwayland.enable = true;
  };

  programs.hyprlock.enable = true;
  services.blueman.enable = true;

  # Prefer native Wayland for Electron/Chromium apps on NixOS.
  environment.sessionVariables.NIXOS_OZONE_WL = "1";

  fonts.packages = with pkgs; [
    nerd-fonts.symbols-only
  ];

  environment.systemPackages = [
    hyprlandSettings
  ] ++ (with pkgs; [
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
    nwg-displays
    nwg-look
    pavucontrol
    wlogout
    hyprpolkitagent
    adwaita-icon-theme
    hicolor-icon-theme
    papirus-icon-theme
    kdePackages.breeze-icons
  ]);

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
