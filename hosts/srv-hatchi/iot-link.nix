{ config, ... }:
{
  hardware.wirelessRegulatoryDatabase = true;
  networking.wireless = {
    enable = true;
    secretsFile = config.my.hatchi.secretFiles.wifiSecrets;
    networks.${config.my.network.ssid}.pskRaw = "ext:wifi_psk";
  };
  networking.dhcpcd.extraConfig = ''
    interface wlp69s0
      metric 2000
  '';
}
