{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.hatchi.onepassword;
  references = {
    cloudflare = "op://Homelab/Cloudflare api token chateau/credential";
    adguardPassword = "op://Homelab/Chateau adguard/password";
    couchdbUsername = "op://Homelab/Obsidian live sync/username";
    couchdbPassword = "op://Homelab/Obsidian live sync/password";
    glanceKey = "op://Homelab/Chateau glance/add more/secret password";
    glancePassword = "op://Homelab/Chateau glance/password";
    grafanaKey = null;
    grafanaPassword = "op://Homelab/Chateau grafana/password";
    nextcloudPassword = "op://Homelab/Chateau nextcloud admin/password";
    qbittorrentPassword = "op://Homelab/Chateau qbittorent/password";
  };
  python = pkgs.python3.withPackages (ps: [ ps.bcrypt ]);
  manifest = pkgs.writeText "hatchi-secret-formats.json" (
    builtins.toJSON {
      rawDirectory = config.services.onepassword-secrets.outputDir;
      adguard = config.services.adguardhome.settings // {
        http.address = "${config.services.adguardhome.host}:${toString config.services.adguardhome.port}";
      };
      qbittorrent = config.services.qbittorrent.serverConfig;
    }
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
        description = "1Password field reference, never its value.";
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
      secrets = lib.mapAttrs (_: reference: {
        inherit reference;
        mode = "0400";
      }) (lib.filterAttrs (_: reference: reference != null) cfg.references);
    };
    systemd.services.opnix-secrets.preStart = ''
      test -s ${lib.escapeShellArg config.services.onepassword-secrets.tokenFile}
    '';
    systemd.services.hatchi-secret-files = {
      description = "Render Hatchi application credentials";
      wantedBy = [ "multi-user.target" ];
      requires = [ "opnix-secrets.service" ];
      after = [ "opnix-secrets.service" ];
      partOf = [ "opnix-secrets.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        RuntimeDirectory = "hatchi-secrets";
        RuntimeDirectoryMode = "0711";
        UMask = "0077";
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ "/run/hatchi-secrets" ];
        NoNewPrivileges = true;
      };
      script = ''
        ${python}/bin/python ${./render-secrets.py} ${manifest} /run/hatchi-secrets
      '';
    };
  };
}
