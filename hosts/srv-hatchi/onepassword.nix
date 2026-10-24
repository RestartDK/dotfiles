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
    adguardGlanceAuth = null;
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
    minifluxApiKey = null;
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
        # Activation restarts the units that carry Hatchi's network, so the
        # resolver is gone for up to two minutes while a new generation comes
        # up. The first fetch then cannot resolve my.1password.com, and since
        # every secret consumer depends on it, one failed attempt aborts the
        # activation and rolls the host back.
        after = [
          "dhcpcd.service"
          "tailscaled.service"
        ];
        path = [
          pkgs.coreutils
          pkgs.dig
          pkgs.gnugrep
        ];
        preStart = ''
          test -s ${lib.escapeShellArg config.services.onepassword-secrets.tokenFile}
          for attempt in $(seq 1 60); do
            if dig +short +time=3 +tries=1 my.1password.com | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
              break
            fi
            sleep 3
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
