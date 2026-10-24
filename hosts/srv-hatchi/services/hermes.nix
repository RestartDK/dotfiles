{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.hatchi.hermes;
  hermes = config.services.hermes-agent;
  common = import "${inputs.hermes-agent}/nix/moduleCommon.nix" { inherit lib; };
  keyFile = "/run/hatchi-onepassword/hermesGoKey";
  hostname = "hermes.${config.my.domain}";
  units = {
    hermes-agent = {
      environment = { };
      argv = common.gatewayArgv hermes;
      credentials.OPENCODE_GO_API_KEY = keyFile;
    };
    hermes-backend = {
      environment = {
        HERMES_DASHBOARD_PUBLIC_URL = "https://${hostname}";
        HERMES_DASHBOARD_BASIC_AUTH_USERNAME = "daniel";
      };
      argv = common.backendArgv {
        inherit pkgs;
        cfg = hermes;
      };
      credentials = {
        OPENCODE_GO_API_KEY = keyFile;
        HERMES_DASHBOARD_BASIC_AUTH_PASSWORD = config.my.hatchi.secretFiles.glancePassword;
      };
    };
  };
in
{
  imports = [ inputs.hermes-agent.nixosModules.default ];

  options.my.hatchi.hermes.apiKeyReference = lib.mkOption {
    type = lib.types.nullOr (lib.types.strMatching "op://.+/.+/.+");
    default = null;
    description = "Existing OpenCode Go API-key field, fetched by Hatchi's service account.";
  };

  config = {
    services.hermes-agent = {
      enable = true;
      package = inputs.self.packages.${pkgs.stdenv.hostPlatform.system}.hermes-agent;
      container.enable = false;
      stateDir = "/var/lib/hermes";
      workingDirectory = "/var/lib/hermes/workspace";
      backend = {
        mode = "dashboard";
        host = "127.0.0.1";
        port = 9119;
      };
      settings = {
        model = {
          provider = "opencode-go";
          default = "glm-5.3-flash";
        };
        terminal.backend = "local";
        approvals = {
          mode = "manual";
          cron_mode = "deny";
          unattended_mode = "deny";
          single_query_mode = "deny";
        };
      };
    };

    services.caddy.virtualHosts.${hostname}.extraConfig = ''
      reverse_proxy 127.0.0.1:${toString hermes.backend.port} {
        header_up -X-Forwarded-Prefix
      }
    '';

    services.onepassword-secrets.secrets = lib.optionalAttrs (cfg.apiKeyReference != null) {
      hermesGoKey = {
        reference = cfg.apiKeyReference;
        path = keyFile;
        owner = "root";
        group = "root";
        mode = "0400";
      };
    };

    systemd.tmpfiles.rules =
      map (directory: "d /var/lib/hermes/.hermes/${directory} 0700 hermes hermes - -")
        [
          "logs/curator"
          "pairing"
          "hooks"
          "image_cache"
          "audio_cache"
          "skills"
        ];

    systemd.services = lib.mapAttrs (name: unit: {
      inherit (unit) environment;
      requires = [ config.my.hatchi.secretService ];
      after = [ config.my.hatchi.secretService ];
      partOf = [ config.my.hatchi.secretService ];
      unitConfig.ConditionPathExists = keyFile;
      serviceConfig = {
        LoadCredential = lib.mapAttrsToList (variable: path: "${variable}:${path}") unit.credentials;
        ExecStart = lib.mkForce (
          pkgs.writeShellScript "${name}-credentials" ''
            set -euo pipefail
            ${lib.concatMapStringsSep "\n" (variable: ''
              ${variable}="$(${pkgs.coreutils}/bin/cat "$CREDENTIALS_DIRECTORY/${variable}")"
              export ${variable}
            '') (builtins.attrNames unit.credentials)}
            exec ${lib.escapeShellArgs unit.argv}
          ''
        );
        UMask = lib.mkForce "0077";
        ProtectHome = lib.mkForce false;
        InaccessiblePaths = [
          "/home"
          "/root"
        ];
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        CapabilityBoundingSet = "";
      };
    }) units;
  };
}
