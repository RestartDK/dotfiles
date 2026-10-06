{ config, ... }:
let
  ssid = "Owner";
in
{
  hardware.wirelessRegulatoryDatabase = true;
  networking.wireless = {
    enable = true;
    secretsFile = config.my.hatchi.secretFiles.wifiSecrets;
    networks.${ssid}.pskRaw = "ext:wifi_psk";
  };
  networking.dhcpcd.extraConfig = ''
    interface wlp69s0
      metric 2000
  '';
  systemd.services.wpa_supplicant = {
    requires = [ config.my.hatchi.secretService ];
    after = [ config.my.hatchi.secretService ];
    partOf = [ config.my.hatchi.secretService ];
  };
}
