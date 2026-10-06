{ config, pkgs, ... }:
let
  inherit (config.my) domain;
  port = 8123;
  python3Packages = pkgs.home-assistant.python3Packages;
  pyaarlo = python3Packages.callPackage ../../../packages/pyaarlo/package.nix { };
  aarlo = pkgs.callPackage ../../../packages/aarlo/package.nix {
    inherit pyaarlo;
    aiofiles = python3Packages.aiofiles;
    unidecode = python3Packages.unidecode;
  };
  sonoff = pkgs.callPackage ../../../packages/sonoff/package.nix { };
in
{
  services.home-assistant = {
    enable = true;
    customComponents = [
      aarlo
      sonoff
    ];
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
    config.default_config = { };
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
