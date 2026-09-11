{
  config,
  lib,
  pkgs,
  ...
}:
let
  qbittorrentConfig = import ./qbittorrent-config.nix {
    inherit pkgs;
    domain = config.my.hatchi.domain;
  };
in
{
  services = {
    jellyfin = {
      enable = true;
      group = "media";
      openFirewall = false;
    };
    seerr = {
      enable = true;
      openFirewall = false;
    };
    radarr = {
      enable = true;
      group = "media";
      dataDir = "/var/lib/radarr";
      settings.server.bindaddress = "127.0.0.1";
    };
    sonarr = {
      enable = true;
      group = "media";
      dataDir = "/var/lib/sonarr";
      settings.server.bindaddress = "127.0.0.1";
    };
    prowlarr = {
      enable = true;
      settings.server.bindaddress = "127.0.0.1";
    };
    qbittorrent = {
      enable = true;
      group = "media";
      webuiPort = 8080;
      openFirewall = false;
    };
    caddy.virtualHosts = {
      "jellyfin.${config.my.hatchi.domain}".extraConfig = "reverse_proxy 127.0.0.1:8096";
      "seerr.${config.my.hatchi.domain}".extraConfig =
        "reverse_proxy 127.0.0.1:${toString config.services.seerr.port}";
      "radarr.${config.my.hatchi.domain}".extraConfig =
        "reverse_proxy 127.0.0.1:${toString config.services.radarr.settings.server.port}";
      "sonarr.${config.my.hatchi.domain}".extraConfig =
        "reverse_proxy 127.0.0.1:${toString config.services.sonarr.settings.server.port}";
      "prowlarr.${config.my.hatchi.domain}".extraConfig =
        "reverse_proxy 127.0.0.1:${toString config.services.prowlarr.settings.server.port}";
      "qbittorrent.${config.my.hatchi.domain}".extraConfig =
        "reverse_proxy 127.0.0.1:${toString config.services.qbittorrent.webuiPort}";
    };
  };
  sops.secrets.qbittorrent-password.restartUnits = [ "qbittorrent.service" ];
  my.hatchi = {
    stateUnits = [
      "jellyfin"
      "seerr"
      "radarr"
      "sonarr"
      "prowlarr"
      "qbittorrent"
    ];
    mediaUnits = [
      "jellyfin"
      "radarr"
      "sonarr"
      "qbittorrent"
    ];
  };
  users.users = lib.genAttrs [ "jellyfin" "radarr" "sonarr" "qbittorrent" ] (_: {
    extraGroups = [ "media" ];
  });
  systemd.services = {
    jellyfin.serviceConfig = {
      ReadOnlyPaths = [ "/srv/media" ];
      StateDirectory = "jellyfin";
      StateDirectoryMode = "0700";
    };
    radarr.serviceConfig = {
      UMask = lib.mkForce "0002";
      ReadOnlyPaths = [ "/srv/media" ];
      ReadWritePaths = [
        "/srv/media/movies"
        "/srv/media/downloads"
      ];
    };
    sonarr.serviceConfig = {
      StateDirectory = "sonarr";
      StateDirectoryMode = "0700";
      UMask = lib.mkForce "0002";
      ReadOnlyPaths = [ "/srv/media" ];
      ReadWritePaths = [
        "/srv/media/tvshows"
        "/srv/media/downloads"
      ];
    };
    qbittorrent.serviceConfig = {
      StateDirectory = "qBittorrent";
      StateDirectoryMode = "0700";
      UMask = "0002";
      ReadOnlyPaths = [ "/srv/media" ];
      ReadWritePaths = [ "/srv/media/downloads" ];
      LoadCredential = [ "password:${config.sops.secrets.qbittorrent-password.path}" ];
      ExecStartPre = [
        "${lib.getExe qbittorrentConfig} ${config.services.qbittorrent.profileDir}/qBittorrent/config/qBittorrent.conf"
      ];
    };
  };
}
