{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.hatchi.onepassword;
  enabled = lib.any (reference: reference != null) (builtins.attrValues cfg.references);
  paths = config.services.onepassword-secrets.secretPaths;
  references = {
    cloudflare = null;
    adguardPasswordHash = null;
    couchdbAdmin = null;
    glanceKey = null;
    glancePassword = null;
    grafanaKey = null;
    grafanaPassword = null;
    homelabSshKey = null;
    minifluxAdmin = null;
    nextcloudPassword = null;
    qbittorrentPasswordHash = null;
    runnerAccessToken = null;
    mangyEnv = null;
    wifiPsk = null;
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
  wifiSecrets = pkgs.writeText "wpa-secrets.conf" "wifi_psk=@hatchi-wifi-psk@\n";
  secretOverrides = {
    homelabSshKey = {
      path = "/run/onepassword-ssh/id_ed25519";
      owner = config.my.host.userName;
      group = "users";
    };
  };
in
{
  options.my.hatchi.onepassword = {
    tokenFile = lib.mkOption {
      type = lib.types.nullOr (lib.types.strMatching "/[a-zA-Z0-9._/-]+");
      default = null;
      description = "Runtime service-account token file.";
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

  config = lib.mkMerge [
    {
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
    }
    (lib.mkIf enabled {
      # wpa_supplicant reads the PSK as an unprivileged user, so the rendered file
      # and its directory belong to that group even if wireless is later disabled.
      users.groups.wpa_supplicant = { };
      services.onepassword-secrets = {
        enable = true;
        outputDir = "/run/hatchi-onepassword";
        systemdIntegration.enable = false;
        secrets = lib.mapAttrs (
          name: reference:
          {
            inherit reference;
            mode = "0400";
            owner = if lib.hasPrefix "grafana" name then "grafana" else "root";
            group = if lib.hasPrefix "grafana" name then "grafana" else "root";
          }
          // (secretOverrides.${name} or { })
        ) (lib.filterAttrs (_: reference: reference != null) cfg.references);
      };
      systemd.services.opnix-secrets = {
        # The resolver is Tailscale's MagicDNS, and activation restarts
        # tailscaled in the same transaction. Without the ordering and the wait,
        # the first start races that restart, fails to resolve
        # my.1password.com, and latches the unit's two-start limit, which aborts
        # the deployment and rolls the host back.
        after = [ "tailscaled.service" ];
        path = [
          pkgs.coreutils
          pkgs.getent
        ];
        preStart = ''
          test -s ${lib.escapeShellArg config.services.onepassword-secrets.tokenFile}
          for attempt in $(seq 1 30); do
            if getent hosts my.1password.com > /dev/null; then
              break
            fi
            sleep 2
          done
        '';
        postStart = lib.concatMapStringsSep "\n" (path: "test -s ${lib.escapeShellArg path}") (
          builtins.attrValues paths
        );
        # Upstream allows two starts per hour with a fifteen minute backoff, so
        # one failed fetch blocks every later attempt until the hour clears.
        # This keeps a rate bound while letting a transient failure recover.
        unitConfig = {
          StartLimitBurst = lib.mkForce 10;
          StartLimitIntervalSec = lib.mkForce "10min";
        };
        serviceConfig.RestartSec = lib.mkForce "20s";
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
          RuntimeDirectoryMode = "0710";
          Group = "wpa_supplicant";
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
          ${pkgs.coreutils}/bin/install -g wpa_supplicant -m640 ${wifiSecrets} /run/hatchi-secrets/wpa-secrets.conf
          ${pkgs.replace-secret}/bin/replace-secret '@hatchi-wifi-psk@' ${paths.wifiPsk} /run/hatchi-secrets/wpa-secrets.conf
        '';
      };
    })
  ];
}
