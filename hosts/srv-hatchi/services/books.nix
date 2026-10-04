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
  services.caddy.virtualHosts."komga.${config.my.domain}".extraConfig =
    "reverse_proxy 127.0.0.1:${toString config.services.komga.settings.server.port}";
  my.hatchi = {
    stateUnits = [ "komga" ];
    mediaUnits = [ "komga" ];
  };
  users.users.komga.extraGroups = [ "media" ];
  systemd.services.komga.serviceConfig = {
    StateDirectoryMode = "0700";
    ReadOnlyPaths = [ "/srv/media" ];
    Environment = "JAVA_TOOL_OPTIONS=-Xmx512m";
  };
}
