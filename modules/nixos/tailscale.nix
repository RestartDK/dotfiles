{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.tailscale;
  host = config.my.host;
  boolToString = value: if value then "true" else "false";
  tailscaleHostName = if cfg.hostName != null then cfg.hostName else config.networking.hostName;
  operator = if cfg.operator != null then cfg.operator else host.userName;
in
{
  imports = [ ./host-options.nix ];

  options.my.tailscale = {
    applyPreferences = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to apply reproducible non-secret Tailscale preferences with tailscale set.";
    };

    hostName = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "srv-nana";
      description = "Tailscale hostname. Null uses networking.hostName.";
    };

    operator = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "dkumlin";
      description = "Tailscale operator. Null uses my.host.userName.";
    };

    acceptDns = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether Tailscale should manage DNS.";
    };

    acceptRoutes = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether Tailscale should accept advertised routes.";
    };
  };

  config = {
    services.tailscale = {
      enable = true;
      useRoutingFeatures = "client";
    };

    networking.firewall.trustedInterfaces = [ "tailscale0" ];
    networking.firewall.allowedUDPPorts = [ 41641 ];
    networking.firewall.checkReversePath = "loose";

    # Keep non-secret Tailscale preferences reproducible. Authentication remains
    # stateful in /var/lib/tailscale and is intentionally not committed.
    systemd.services.tailscale-preferences = lib.mkIf cfg.applyPreferences {
      description = "Apply Tailscale preferences for ${tailscaleHostName}";
      after = [ "tailscaled.service" ];
      wants = [ "tailscaled.service" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        ${pkgs.tailscale}/bin/tailscale set \
          --hostname=${lib.escapeShellArg tailscaleHostName} \
          --accept-dns=${boolToString cfg.acceptDns} \
          --accept-routes=${boolToString cfg.acceptRoutes} \
          --operator=${lib.escapeShellArg operator}
      '';
    };
  };
}
