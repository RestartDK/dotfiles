{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.hatchi;
  inherit (cfg) domain;
  names = lib.concatMap (host: [ host.hostName ] ++ host.serverAliases) (
    builtins.attrValues config.services.caddy.virtualHosts
  );
  validName =
    name:
    lib.hasSuffix ".${domain}" name
    && builtins.stringLength name <= 253
    && builtins.all (label: builtins.match "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?" label != null) (
      lib.splitString "." name
    );
  adguardCredentials = import ./adguard-credentials.nix { inherit pkgs; };
  networks =
    if cfg.network == null then
      {
        clientNetworks = [ ];
        adminNetworks = [ ];
      }
    else
      cfg.network;
  ingress =
    ranges: protocols: ports:
    lib.concatMapStringsSep "\n" (
      range:
      "${
        if lib.hasInfix ":" range then "ip6" else "ip"
      } saddr ${range} meta l4proto { ${protocols} } th dport { ${ports} } accept"
    ) ranges;
in
{
  options.my.hatchi.edgeNames = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    readOnly = true;
    internal = true;
  };
  options.services.caddy.virtualHosts = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule { useACMEHost = lib.mkDefault domain; });
  };
  config = {
    my.hatchi.edgeNames = names;
    assertions = [
      {
        assertion =
          builtins.all validName names && builtins.length names == builtins.length (lib.unique names);
        message = "Hachi Caddy routes must be unique FQDNs below the configured domain";
      }
      {
        assertion = config.services.caddy.settings == { } && config.services.caddy.extraConfig == "";
        message = "Hachi routes must use native Caddy virtualHosts";
      }
    ];
    services.caddy = {
      enable = true;
      package = pkgs.caddy;
      openFirewall = false;
    };
    security.acme = {
      acceptTerms = true;
      defaults.email = null;
      certs.${domain} = {
        extraDomainNames = [ "*.${domain}" ];
        dnsProvider = "cloudflare";
        environmentFile = config.sops.secrets.cloudflare.path;
        group = "caddy";
      };
    };
    sops.secrets.cloudflare.restartUnits = [ "acme-${domain}.service" ];
    sops.secrets.adguard-users.restartUnits = [ "adguardhome.service" ];
    services.adguardhome = {
      enable = true;
      host = "127.0.0.1";
      port = 3000;
      mutableSettings = false;
      settings = {
        users = [ ];
        dns = {
          bind_hosts = [
            "0.0.0.0"
            "::"
          ];
          port = 53;
          upstream_dns = if cfg.network == null then [ ] else cfg.network.upstreamDNS;
          bootstrap_dns = [ ];
          use_private_ptr_resolvers = false;
        };
        filtering = {
          protection_enabled = true;
          filtering_enabled = true;
          rewrites = lib.optionals (cfg.network != null) (
            map (name: {
              domain = name;
              answer = cfg.network.dnsAnswer;
            }) names
          );
        };
        filters = [ ];
      };
    };
    services.caddy.virtualHosts."adguard.${domain}".extraConfig =
      "reverse_proxy 127.0.0.1:${toString config.services.adguardhome.port}";
    systemd.services =
      lib.genAttrs
        (lib.optionals (builtins.hasAttr domain config.security.acme.certs) [
          "acme-${domain}"
          "acme-order-renew-${domain}"
        ])
        (_: {
          requires = [
            "hatchi-admission.service"
            "sops-install-secrets.service"
          ];
          after = [
            "hatchi-admission.service"
            "sops-install-secrets.service"
          ];
        })
      // {
        adguardhome = {
          serviceConfig.LoadCredential = [ "users:${config.sops.secrets.adguard-users.path}" ];
          preStart = lib.mkAfter ''
            ${lib.getExe adguardCredentials} "$STATE_DIRECTORY/AdGuardHome.yaml"
            ${lib.getExe config.services.adguardhome.package} --check-config -c "$STATE_DIRECTORY/AdGuardHome.yaml"
          '';
        };
      };
    my.hatchi.stateUnits = [
      "adguardhome"
      "caddy"
    ];
    networking.nftables.enable = true;
    networking.firewall = {
      enable = true;
      trustedInterfaces = lib.mkForce [ "lo" ];
      allowedTCPPorts = lib.mkForce [ ];
      allowedUDPPorts = lib.mkForce [ ];
      extraInputRules = ''
        ${ingress networks.clientNetworks "tcp, udp" "53"}
        ${ingress networks.clientNetworks "tcp" "80, 443"}
        ${ingress networks.clientNetworks "udp" "443"}
        ${ingress networks.adminNetworks "tcp" "22"}
        udp dport ${toString config.services.tailscale.port} accept
      '';
    };
  };
}
