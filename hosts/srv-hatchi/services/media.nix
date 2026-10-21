{
  config,
  lib,
  pkgs,
  ...
}:
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
      serverConfig = {
        LegalNotice.Accepted = true;
        Preferences = {
          "WebUI\\Address" = "127.0.0.1";
          "WebUI\\Username" = "daniel";
          "WebUI\\Password_PBKDF2" = "@hatchi-qbittorrent-hash@";
          "WebUI\\ServerDomains" = "qbittorrent.${config.my.domain}";
          "WebUI\\LocalHostAuth" = true;
          "WebUI\\AuthSubnetWhitelistEnabled" = false;
          "WebUI\\CSRFProtection" = true;
          "WebUI\\HostHeaderValidation" = true;
        };
        BitTorrent."Session\\DefaultSavePath" = "/srv/media/downloads";
      };
    };
    caddy.virtualHosts = {
      "jellyfin.${config.my.domain}".extraConfig = "reverse_proxy 127.0.0.1:8096";
      "seerr.${config.my.domain}".extraConfig =
        "reverse_proxy 127.0.0.1:${toString config.services.seerr.port}";
      "radarr.${config.my.domain}".extraConfig =
        "reverse_proxy 127.0.0.1:${toString config.services.radarr.settings.server.port}";
      "sonarr.${config.my.domain}".extraConfig =
        "reverse_proxy 127.0.0.1:${toString config.services.sonarr.settings.server.port}";
      "prowlarr.${config.my.domain}".extraConfig =
        "reverse_proxy 127.0.0.1:${toString config.services.prowlarr.settings.server.port}";
      "qbittorrent.${config.my.domain}".extraConfig =
        "reverse_proxy 127.0.0.1:${toString config.services.qbittorrent.webuiPort}";
    };
  };
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
      LoadCredential = [ "config:${config.my.hatchi.secretFiles.qbittorrentConfig}" ];
      ExecStartPre = lib.mkForce [
        "${pkgs.coreutils}/bin/install -Dm600 %d/config ${config.services.qbittorrent.profileDir}/qBittorrent/config/qBittorrent.conf"
      ];
    };
  };
}
