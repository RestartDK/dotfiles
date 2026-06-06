{ lib, pkgs, ... }:

let
  rustdeskPackage = pkgs.rustdesk-flutter;
  rustdeskHelperPath = lib.makeBinPath [
    pkgs.coreutils
    pkgs.findutils
    pkgs.gawk
    pkgs.glibc.bin
    pkgs.gnugrep
    pkgs.gnused
    pkgs.procps
    pkgs.systemd
    pkgs.util-linux
    pkgs.which
    pkgs.xdg-utils
    pkgs.xhost
    pkgs.xrandr
  ];
in
{
  environment.systemPackages = [
    rustdeskPackage
  ];

  # RustDesk client/service for remote access through Daniel's self-hosted
  # RustDesk rendezvous/relay server. Server/key/password config is local
  # machine state under ~/.config/rustdesk and /root/.config/rustdesk; do not
  # commit it to this repo.
  systemd.services.rustdesk = {
    description = "RustDesk remote desktop service";
    after = [ "network-online.target" "display-manager.service" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "graphical.target" ];

    serviceConfig = {
      Type = "simple";
      ExecStart = "${rustdeskPackage}/bin/rustdesk --service";
      # RustDesk spawns helper commands like sudo, ps, awk, loginctl, xrandr,
      # and xdg-screensaver from the service process. NixOS' default service
      # PATH is intentionally tiny, and the setuid sudo/pkexec wrappers live in
      # /run/wrappers/bin, so provide an explicit helper PATH.
      Environment = "PATH=/run/wrappers/bin:${rustdeskHelperPath}";
      Restart = "on-failure";
      RestartSec = "5s";
    };
  };
}
