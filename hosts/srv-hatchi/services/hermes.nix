{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.hatchi.hermes;
  environmentFile = "/run/hatchi-onepassword/hermesEnv";
in
{
  imports = [ inputs.hermes-agent.nixosModules.default ];

  options.my.hatchi.hermes.environmentReference = lib.mkOption {
    type = lib.types.nullOr (lib.types.strMatching "op://.+/.+/.+");
    default = null;
    description = "1Password field containing Hermes's provider environment file.";
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
          provider = "openrouter";
          default = "deepseek/deepseek-v4.1-flash";
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

    services.onepassword-secrets.secrets = lib.optionalAttrs (cfg.environmentReference != null) {
      hermesEnv = {
        reference = cfg.environmentReference;
        path = environmentFile;
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

    systemd.services = lib.genAttrs [ "hermes-agent" "hermes-backend" ] (_: {
      requires = [ config.my.hatchi.secretService ];
      after = [ config.my.hatchi.secretService ];
      partOf = [ config.my.hatchi.secretService ];
      unitConfig.ConditionPathExists = environmentFile;
      serviceConfig = {
        EnvironmentFile = [ environmentFile ];
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
    });
  };
}
