{ config, ... }:
let
  port = 12000;
in
{
  services.miniflux = {
    enable = true;
    adminCredentialsFile = config.my.hatchi.secretFiles.minifluxAdmin;
    config = {
      LISTEN_ADDR = "127.0.0.1:${toString port}";
      BASE_URL = "https://miniflux.${config.my.domain}";
    };
  };

  services.caddy.virtualHosts."miniflux.${config.my.domain}".extraConfig =
    "reverse_proxy 127.0.0.1:${toString port}";
  my.hatchi.stateUnits = [ "miniflux" ];
}
