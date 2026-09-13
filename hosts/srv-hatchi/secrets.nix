{
  inputs,
  config,
  lib,
  ...
}:
let
  onePassword = config.services.onepassword-secrets;
  cfg = config.my.hatchi.onepassword;
  sopsToken = onePassword.enable && cfg.tokenFile == null;
  secretNames = {
    cloudflare = "cloudflare";
    couchdbAdmin = "couchdb-admin";
    glanceKey = "glance-key";
    glancePassword = "glance-password";
    grafanaKey = "grafana-key";
    grafanaPassword = "grafana-password";
    nextcloudPassword = "nextcloud-admin";
  };
  templateNames = {
    adguardConfig = "AdGuardHome.yaml";
    qbittorrentConfig = "qBittorrent.conf";
  };
  afterSops = {
    requires = [ "sops-install-secrets.service" ];
    after = [ "sops-install-secrets.service" ];
  };
in
{
  imports = [
    inputs.sops-nix.nixosModules.sops
    inputs.opnix.nixosModules.default
    ./onepassword.nix
  ];
  options.my.hatchi = {
    secretFiles = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      readOnly = true;
      internal = true;
    };
    secretService = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      internal = true;
    };
  };
  config = {
    my.hatchi = {
      secretFiles =
        if cfg.enable then
          lib.mapAttrs (_: name: "/run/hatchi-secrets/${name}") (secretNames // templateNames)
        else
          lib.mapAttrs (_: name: config.sops.secrets.${name}.path) secretNames
          // lib.mapAttrs (_: name: config.sops.templates.${name}.path) templateNames;
      secretService =
        if cfg.enable then "hatchi-secret-files.service" else "sops-install-secrets.service";
    };
    services.onepassword-secrets = {
      enable = lib.mkDefault (onePassword.secrets != { } || onePassword.configFiles != [ ]);
      tokenFile = lib.mkIf onePassword.enable (
        if cfg.tokenFile == null then config.sops.secrets.opnix-token.path else cfg.tokenFile
      );
    };
    sops = {
      useSystemdActivation = true;
      defaultSopsFile = "/var/lib/sops/srv-hatchi.yaml";
      validateSopsFiles = false;
      age = {
        keyFile = "/var/lib/sops/age/keys.txt";
        sshKeyPaths = [ ];
      };
      gnupg.sshKeyPaths = [ ];
      secrets.opnix-token = lib.mkIf sopsToken {
        group = "onepassword-secrets";
        mode = "0640";
        restartUnits = [ "opnix-secrets.service" ];
      };
    };
    systemd.services = lib.mkIf sopsToken {
      opnix-secrets = afterSops;
      opnix-secrets-restart = lib.mkIf (
        onePassword.systemdIntegration.enable && onePassword.systemdIntegration.changeDetection.enable
      ) afterSops;
      opnix-secrets-poll = lib.mkIf (
        onePassword.systemdIntegration.enable && onePassword.systemdIntegration.polling.enable
      ) afterSops;
    };
    assertions = lib.mapAttrsToList (name: secret: {
      assertion = lib.hasPrefix "/run/secrets/" secret.path;
      message = "Hatchi secret ${name} must be a runtime file";
    }) config.sops.secrets;
  };
}
