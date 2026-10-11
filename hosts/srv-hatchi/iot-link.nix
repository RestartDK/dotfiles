{ config, lib, ... }:
let
  ssid = "Owner";
  iotLink = config.my.network.iotLink;
  iotParts = lib.splitString "/" iotLink.network;
  iotAddress = builtins.elemAt iotParts 0;
  iotPrefix = lib.toInt (builtins.elemAt iotParts 1);
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
  # The leg exists for multicast discovery, not for reachability. The access
  # point bridges the IoT SSID to the wireless clients only, so the wired
  # devices on that subnet answer on the routed path and not over the leg. This
  # keeps unicast on the wire, where it already worked, and sends the multicast
  # range out the leg so Home Assistant hears mDNS and SSDP on the subnet.
  networking.interfaces.enp68s0.ipv4.routes = [
    {
      address = iotAddress;
      prefixLength = iotPrefix;
      via = iotLink.gateway;
      options = {
        metric = "100";
        scope = "global";
      };
    }
  ];
  networking.interfaces.wlp69s0.ipv4.routes = [
    {
      address = "224.0.0.0";
      prefixLength = 4;
      type = "multicast";
    }
  ];
  systemd.services.wpa_supplicant = {
    requires = [ config.my.hatchi.secretService ];
    after = [ config.my.hatchi.secretService ];
    partOf = [ config.my.hatchi.secretService ];
  };
}
