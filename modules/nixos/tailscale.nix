{ ... }:

{
  services.tailscale = {
    enable = true;
    useRoutingFeatures = "client";
  };

  networking.firewall.trustedInterfaces = [ "tailscale0" ];
  networking.firewall.allowedUDPPorts = [ 41641 ];
  networking.firewall.checkReversePath = "loose";
}
