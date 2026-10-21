{ config, ... }:
let
  inherit (config.my) domain;
  port = 8123;
in
{
  services.home-assistant = {
    enable = true;
    extraComponents = [
      "assist_pipeline"
      "bluetooth"
      "camera"
      "cloud"
      "conversation"
      "default_config"
      "dhcp"
      "esphome"
      "ffmpeg"
      "file"
      "go2rtc"
      "google_translate"
      "image_upload"
      "ipp"
      "matter"
      "met"
      "mobile_app"
      "recorder"
      "samsungtv"
      "sonos"
      "spotify"
      "ssdp"
      "stream"
      "tts"
      "usb"
      "zeroconf"
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
