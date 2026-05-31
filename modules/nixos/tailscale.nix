{ pkgs, ... }:

{
  services.tailscale = {
    enable = true;
    useRoutingFeatures = "client";
  };

  networking.firewall.trustedInterfaces = [ "tailscale0" ];
  networking.firewall.allowedUDPPorts = [ 41641 ];
  networking.firewall.checkReversePath = "loose";


  # Keep non-secret Tailscale preferences reproducible. Authentication remains
  # stateful in /var/lib/tailscale and is intentionally not committed.
  systemd.services.tailscale-preferences = {
    description = "Apply Nana Tailscale preferences";
    after = [ "tailscaled.service" ];
    wants = [ "tailscaled.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      ${pkgs.tailscale}/bin/tailscale set \
        --hostname=srv-nana \
        --accept-dns=true \
        --accept-routes=true \
        --operator=dkumlin
    '';
  };

}
