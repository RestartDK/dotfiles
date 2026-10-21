{
  config,
  lib,
  pkgs,
  ...
}:

let
  uwsmSessionCommand = lib.escapeShellArgs [
    (lib.getExe config.programs.uwsm.package)
    "start"
    "-e"
    "-D"
    "Hyprland"
    "hyprland.desktop"
  ];
in
{
  programs.hyprland = {
    enable = true;
    xwayland.enable = true;
    withUWSM = true;
  };

  programs.hyprlock.enable = true;

  services.greetd = {
    enable = true;
    useTextGreeter = true;
    settings.default_session = {
      command = "${lib.getExe pkgs.tuigreet} --time --remember --asterisks --cmd ${lib.escapeShellArg uwsmSessionCommand}";
      user = "greeter";
    };
  };

  hardware.bluetooth.enable = true;
  services.blueman.enable = true;

  # Prefer native Wayland for Electron/Chromium apps on NixOS.
  environment.sessionVariables.NIXOS_OZONE_WL = "1";

  fonts.packages = with pkgs; [
    nerd-fonts.symbols-only
  ];

  environment.systemPackages = with pkgs; [
    ghostty
    waybar
    fuzzel
    grimblast
    slurp
    wl-clipboard
    playerctl
    brightnessctl
    hyprlauncher
    hyprpaper
    hyprpicker
    hyprsunset
    hyprcursor
    hyprland-qt-support
    hyprland-qtutils
    hyprpwcenter
    hyprsysteminfo
    networkmanagerapplet
    thunar
    thunar-volman
    tumbler
    nwg-displays
    nwg-look
    pavucontrol
    wlogout
    hyprpolkitagent
    adwaita-icon-theme
    hicolor-icon-theme
    papirus-icon-theme
    kdePackages.breeze-icons
  ];

  systemd.user.targets.graphical-session.wants = [ "hyprpolkitagent.service" ];
}
