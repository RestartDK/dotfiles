{ config, ... }:
{
  services.komga = {
    enable = true;
    group = "media";
    settings.server = {
      address = "127.0.0.1";
      port = 25600;
    };
  };
  services.suwayomi-server = {
    enable = true;
    group = "media";
    settings.server = {
      ip = "127.0.0.1";
      port = 4567;
      basicAuthEnabled = false;
      downloadsPath = "/srv/media/manga";
      localSourcePath = "/srv/media/manga";
    };
  };
  services.caddy.virtualHosts = {
    "komga.${config.my.hatchi.domain}".extraConfig =
      "reverse_proxy 127.0.0.1:${toString config.services.komga.settings.server.port}";
    "suwayomi.${config.my.hatchi.domain}".extraConfig =
      "reverse_proxy 127.0.0.1:${toString config.services.suwayomi-server.settings.server.port}";
  };
  my.hatchi = {
    stateUnits = [
      "komga"
      "suwayomi-server"
    ];
    mediaUnits = [
      "komga"
      "suwayomi-server"
    ];
  };
  users.users.komga.extraGroups = [ "media" ];
  users.users.suwayomi.extraGroups = [ "media" ];
  systemd.services.komga.serviceConfig = {
    StateDirectoryMode = "0700";
    ReadOnlyPaths = [ "/srv/media" ];
    Environment = "JAVA_TOOL_OPTIONS=-Xmx512m";
  };
  systemd.services.suwayomi-server.serviceConfig = {
    StateDirectoryMode = "0700";
    UMask = "0002";
    ReadOnlyPaths = [ "/srv/media" ];
    ReadWritePaths = [ "/srv/media/manga" ];
    Environment = "JAVA_TOOL_OPTIONS=-Xmx512m";
  };
}
