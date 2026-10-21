{ pkgs, self }:
let
  inherit (pkgs) lib;
  cfg = self.nixosConfigurations.srv-nana.config;
  options = self.nixosConfigurations.srv-nana.options;
  home = cfg.home-manager.users.${cfg.my.host.userName};
  tuigreet = lib.getExe self.nixosConfigurations.srv-nana.pkgs.tuigreet;
  uwsmSessionCommand = "${lib.getExe cfg.programs.uwsm.package} start -e -D Hyprland hyprland.desktop";
  portalNames = map lib.getName cfg.xdg.portal.extraPortals;
  systemPackageNames = map lib.getName cfg.environment.systemPackages;
  gnomeServiceNames = builtins.filter (
    name:
    let
      serviceOptions = options.services.gnome.${name};
    in
    builtins.isAttrs serviceOptions
    && serviceOptions ? enable
    && (serviceOptions.enable.visible or true)
  ) (builtins.attrNames options.services.gnome);
in
assert cfg.services.greetd.enable && cfg.services.greetd.useTextGreeter;
assert !(cfg.services.greetd.settings ? initial_session);
assert
  cfg.services.greetd.settings.default_session.command
  == "${tuigreet} --time --remember --asterisks --cmd ${lib.escapeShellArg uwsmSessionCommand}";
assert cfg.services.greetd.settings.default_session.user == "greeter";
assert !cfg.services.displayManager.gdm.enable;
assert !cfg.services.desktopManager.gnome.enable;
assert !cfg.services.xserver.enable;
assert builtins.all (service: !(service.enableGnomeKeyring or false)) (
  builtins.attrValues cfg.security.pam.services
);
assert !cfg.services.gnome.gnome-keyring.enable;
assert !cfg.services.gvfs.enable;
assert !cfg.services.gnome.gcr-ssh-agent.enable;
assert !cfg.services.accounts-daemon.enable;
assert !cfg.services.upower.enable;
assert !cfg.services.power-profiles-daemon.enable;
assert builtins.all (name: !cfg.services.gnome.${name}.enable) gnomeServiceNames;
assert cfg.services.displayManager.sessionPackages == [ cfg.programs.hyprland.package ];
assert cfg.programs.hyprland.enable;
assert cfg.programs.hyprland.xwayland.enable;
assert cfg.programs.hyprland.withUWSM;
assert cfg.programs.uwsm.enable;
assert builtins.elem cfg.programs.uwsm.package cfg.systemd.packages;
assert cfg.services.hypridle.enable;
assert builtins.elem "graphical-session.target" cfg.systemd.user.services.hypridle.wantedBy;
assert builtins.elem "hyprpolkitagent.service" cfg.systemd.user.targets.graphical-session.wants;
assert !(cfg.systemd.user.services ? hyprpolkitagent);
assert cfg.services.graphical-desktop.enable;
assert
  lib.sort builtins.lessThan portalNames == [
    "xdg-desktop-portal-gtk"
    "xdg-desktop-portal-hyprland"
  ];
assert cfg.services.printing.enable;
assert cfg.services.avahi.enable;
assert cfg.services.pipewire.enable;
assert cfg.services.udisks2.enable;
assert cfg.hardware.bluetooth.enable;
assert cfg.security.polkit.enable;
assert cfg.programs.firefox.enable;
assert cfg.programs._1password.enable && cfg.programs._1password-gui.enable;
assert home.services.udiskie.enable;
assert home.systemd.user.services ? udiskie;
assert builtins.elem "graphical-session.target" home.systemd.user.services.udiskie.Install.WantedBy;
assert builtins.elem "graphical-session.target" home.systemd.user.services.udiskie.Unit.PartOf;
assert !(builtins.elem "gnome-control-center" systemPackageNames);
assert !(builtins.elem "hyprshutdown" systemPackageNames);
assert !(builtins.elem "udiskie" systemPackageNames);
assert builtins.all (
  name:
  let
    fileName = builtins.baseNameOf name;
  in
  !(lib.hasPrefix "gnome-" fileName) && !(lib.hasPrefix "org.gnome." fileName)
) (builtins.attrNames home.xdg.dataFile);
assert home.gtk.colorScheme == "dark";
assert home.gtk.gtk3.colorScheme == "dark";
assert home.gtk.gtk4.colorScheme == "dark";
assert home.dconf.settings."org/gnome/desktop/interface"."color-scheme" == "prefer-dark";
assert home.gtk.iconTheme.name == "Papirus";
assert lib.getName home.gtk.iconTheme.package == "papirus-icon-theme";
assert home.home.pointerCursor.name == "Adwaita";
assert lib.getName home.home.pointerCursor.package == "adwaita-icon-theme";
pkgs.runCommand "srv-nana-policy" { } ''
  touch $out
''
