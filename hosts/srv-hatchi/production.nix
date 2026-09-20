{ config, ... }:
{
  my.hatchi = {
    network = {
      dnsAnswer = "192.168.200.70";
      clientNetworks = [ "192.168.200.0/24" ];
      adminNetworks = [ "192.168.200.0/24" ];
      upstreamDNS = [
        "1.1.1.1"
        "9.9.9.9"
      ];
    };
    onepassword = {
      enable = true;
      references = {
        cloudflare = "op://Homelab/Cloudflare api token chateau/nixos-acme-environment";
        adguardPasswordHash = "op://Homelab/Chateau adguard/nixos-password-hash";
        couchdbAdmin = "op://Homelab/Obsidian live sync/nixos-admin-config";
        glanceKey = "op://Homelab/Chateau glance/secret password";
        glancePassword = "op://Homelab/Chateau glance/password";
        grafanaKey = "op://Homelab/Chateau grafana/nixos-secret-key";
        grafanaPassword = "op://Homelab/Chateau grafana/password";
        nextcloudPassword = "op://Homelab/Chateau nextcloud admin/password";
        qbittorrentPasswordHash = "op://Homelab/Chateau qbittorent/nixos-password-hash";
      };
    };
  };
  assertions = [
    {
      assertion =
        config.my.hatchi.network != null
        && config.my.hatchi.network.clientNetworks != [ ]
        && config.my.hatchi.network.upstreamDNS != [ ];
      message = "Hatchi requires client networks and upstream DNS resolvers before deployment";
    }
  ];
}
