{ pkgs, ... }:

{
  environment.systemPackages = with pkgs; [
    rustdesk-flutter
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
      ExecStart = "${pkgs.rustdesk-flutter}/bin/rustdesk --service";
      Restart = "on-failure";
      RestartSec = "5s";
    };
  };
}
