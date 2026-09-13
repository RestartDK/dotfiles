{ pkgs, ... }:

{
  imports = [
    ../../modules/home/dev-packages.nix
    ../../modules/home/live-symlinks.nix
  ];

  home.username = "dkumlin";
  home.homeDirectory = "/home/dkumlin";
  home.stateVersion = "26.05";

  gtk = {
    enable = true;
    iconTheme = {
      package = pkgs.papirus-icon-theme;
      name = "Papirus";
    };
    colorScheme = "dark";
  };

  services.udiskie.enable = true;

  home.pointerCursor = {
    enable = true;
    package = pkgs.adwaita-icon-theme;
    name = "Adwaita";
    size = 24;
    gtk.enable = true;
    x11.enable = true;
    dotIcons.enable = true;
  };

  xdg.mimeApps = {
    enable = true;
    defaultApplications = {
      "inode/directory" = [ "thunar.desktop" ];
    };
  };

  xdg.desktopEntries = {
    hyprland-settings = {
      name = "Settings Hub";
      genericName = "System Settings";
      comment = "Open Hyprland settings hub";
      exec = "/home/dkumlin/.config/hypr/scripts/settings-hub";
      icon = "preferences-system";
      categories = [ "Settings" ];
    };

    settings-bluetooth = {
      name = "Bluetooth";
      genericName = "Bluetooth Settings";
      comment = "Pair and manage Bluetooth devices";
      exec = "blueman-manager";
      icon = "blueman";
      categories = [ "Settings" ];
    };

    settings-displays = {
      name = "Displays";
      genericName = "Display Settings";
      comment = "Configure monitor layout, scale, and refresh rate";
      exec = "nwg-displays";
      icon = "nwg-displays";
      categories = [ "Settings" ];
    };

    settings-sound = {
      name = "Sound";
      genericName = "Sound Settings";
      comment = "Configure audio devices and volume";
      exec = "pavucontrol";
      icon = "org.pulseaudio.pavucontrol";
      categories = [ "Settings" ];
    };

    settings-network = {
      name = "Network";
      genericName = "Network Settings";
      comment = "Configure NetworkManager connections";
      exec = "nm-connection-editor";
      icon = "preferences-system-network";
      categories = [ "Settings" ];
    };

    settings-appearance = {
      name = "Appearance";
      genericName = "Appearance Settings";
      comment = "Configure GTK theme, icons, and fonts";
      exec = "nwg-look";
      icon = "nwg-look";
      categories = [ "Settings" ];
    };

    settings-printers = {
      name = "Printers";
      genericName = "Printer Settings";
      comment = "Open CUPS printer management";
      exec = "xdg-open http://localhost:631/";
      icon = "cups";
      categories = [ "Settings" ];
    };

    settings-nvidia = {
      name = "NVIDIA";
      genericName = "NVIDIA Settings";
      comment = "Configure NVIDIA GPU settings";
      exec = "nvidia-settings";
      icon = "nvidia-settings";
      categories = [ "Settings" ];
    };

    settings-system-info = {
      name = "System Info";
      genericName = "System Information";
      comment = "Show Hyprland system information";
      exec = "hyprsysteminfo";
      icon = "hwinfo";
      categories = [ "Settings" ];
    };

    settings-power = {
      name = "Power";
      genericName = "Power Menu";
      comment = "Log out, reboot, or shut down";
      exec = "wlogout";
      icon = "system-shutdown";
      categories = [ "Settings" ];
    };

    settings-nixos-config = {
      name = "NixOS Config";
      genericName = "NixOS Configuration";
      comment = "Open the NixOS configuration repository";
      exec = "xdg-open /home/dkumlin/.config/dotfiles";
      icon = "folder";
      categories = [ "Settings" ];
    };
  };

  xdg.dataFile = builtins.listToAttrs (
    map
      (desktopFile: {
        name = "applications/${desktopFile}";
        value = {
          force = true;
          text = ''
            [Desktop Entry]
            Name=Hidden Duplicate Settings
            Exec=false
            Type=Application
            NoDisplay=true
          '';
        };
      })
      [
        "blueman-adapters.desktop"
        "blueman-manager.desktop"
        "cups.desktop"
        "hyprsysteminfo.desktop"
        "nm-connection-editor.desktop"
        "nvidia-settings.desktop"
        "nwg-displays.desktop"
        "nwg-look.desktop"
        "org.pulseaudio.pavucontrol.desktop"
      ]
  );

  my.liveConfig = {
    enable = true;
    repoRoot = "/home/dkumlin/.config/dotfiles";
    sync.enable = true;
    groups = {
      shell = true;
      git = true;
      editors = true;
      terminalTools = true;
      ghostty = true;
      wayland = true;
      multiplexer = true;
      agents = true;
    };
  };
}
