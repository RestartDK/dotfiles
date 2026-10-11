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
  # The leg exists for multicast discovery, not for reachability. The wireless
  # access point bridges the IoT SSID to the wireless clients only, so the wired
  # devices on that subnet answer on the routed path and not over the leg. This
  # keeps unicast on the wire, where it already worked, and sends multicast out
  # the leg so Home Assistant hears mDNS and SSDP on the subnet.
  networking.interfaces.enp68s0.ipv4.routes = [
    {
      address = "192.168.205.0";
      prefixLength = 24;
      via = "192.168.200.1";
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
