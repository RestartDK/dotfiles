{ config, ... }:
let
  inherit (config.my.hatchi) domain;
  port = 8123;
in
{
  services.home-assistant = {
    enable = true;
    extraComponents = [
      "default_config"
      "esphome"
      "ipp"
      "met"
      "samsungtv"
      "sonos"
    ];
    config.http = {
      server_host = "127.0.0.1";
      server_port = port;
      use_x_forwarded_for = true;
      trusted_proxies = [ "127.0.0.1" ];
    };
  };
  services.caddy.virtualHosts."homeassistant.${domain}".extraConfig =
    "reverse_proxy 127.0.0.1:${toString port}";
}
