{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.hatchi.onepassword;
  paths = config.services.onepassword-secrets.secretPaths;
  references = {
    cloudflare = null;
    adguardPasswordHash = null;
    couchdbAdmin = null;
    glanceKey = "op://Homelab/Chateau glance/add more/secret password";
    glancePassword = "op://Homelab/Chateau glance/password";
    grafanaKey = null;
    grafanaPassword = "op://Homelab/Chateau grafana/password";
    nextcloudPassword = "op://Homelab/Chateau nextcloud admin/password";
    qbittorrentPasswordHash = null;
  };
  adguardConfig = pkgs.writeText "AdGuardHome.yaml" (
    builtins.toJSON (
      config.services.adguardhome.settings
      // {
        http.address = "${config.services.adguardhome.host}:${toString config.services.adguardhome.port}";
      }
    )
  );
  qbittorrentConfig = pkgs.writeText "qBittorrent.conf" (
    lib.generators.toINI { } config.services.qbittorrent.serverConfig
  );
in
{
  options.my.hatchi.onepassword = {
    enable = lib.mkEnableOption "1Password delivery of Hatchi application secrets";
    tokenFile = lib.mkOption {
      type = lib.types.nullOr (lib.types.strMatching "/[a-zA-Z0-9._/-]+");
      default = null;
      description = "Runtime service-account token file. Null uses the SOPS bootstrap token.";
    };
    references = lib.mapAttrs (
      _: reference:
      lib.mkOption {
        type = lib.types.nullOr (lib.types.strMatching "op://.+/.+/.+");
        default = reference;
        description = "1Password reference to the service-ready credential described in tests/srv-hatchi/onepassword.md.";
      }
    ) references;
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.tokenFile == null || !(lib.hasPrefix "${builtins.storeDir}/" cfg.tokenFile);
        message = "Hatchi's 1Password token must be provisioned outside the Nix store";
      }
    ]
    ++ lib.mapAttrsToList (name: reference: {
      assertion = reference != null;
      message = "Hatchi 1Password reference ${name} must be provisioned before enabling this provider";
    }) cfg.references;

    services.onepassword-secrets = {
      enable = true;
      outputDir = "/run/hatchi-onepassword";
      systemdIntegration.enable = false;
      secrets = lib.mapAttrs (name: reference: {
        inherit reference;
        mode = "0400";
        owner = if lib.hasPrefix "grafana" name then "grafana" else "root";
        group = if lib.hasPrefix "grafana" name then "grafana" else "root";
      }) (lib.filterAttrs (_: reference: reference != null) cfg.references);
    };
    systemd.services.opnix-secrets = {
      preStart = ''
        test -s ${lib.escapeShellArg config.services.onepassword-secrets.tokenFile}
      '';
      postStart = lib.concatMapStringsSep "\n" (path: "test -s ${lib.escapeShellArg path}") (
        builtins.attrValues paths
      );
    };
    systemd.services.hatchi-secret-files = {
      description = "Substitute Hatchi password hashes into declared configuration";
      wantedBy = [ "multi-user.target" ];
      requires = [ "opnix-secrets.service" ];
      after = [ "opnix-secrets.service" ];
      partOf = [ "opnix-secrets.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        RuntimeDirectory = "hatchi-secrets";
        RuntimeDirectoryMode = "0700";
        UMask = "0077";
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ "/run/hatchi-secrets" ];
        NoNewPrivileges = true;
      };
      script = ''
        ${pkgs.coreutils}/bin/install -m400 ${adguardConfig} /run/hatchi-secrets/AdGuardHome.yaml
        ${pkgs.replace-secret}/bin/replace-secret '@hatchi-adguard-hash@' ${paths.adguardPasswordHash} /run/hatchi-secrets/AdGuardHome.yaml
        ${pkgs.coreutils}/bin/install -m400 ${qbittorrentConfig} /run/hatchi-secrets/qBittorrent.conf
        ${pkgs.replace-secret}/bin/replace-secret '@hatchi-qbittorrent-hash@' ${paths.qbittorrentPasswordHash} /run/hatchi-secrets/qBittorrent.conf
      '';
    };
  };
}
