{
  config,
  dotfilesInputs,
  lib,
  pkgs,
  ...
}:
let
  deployments = config.services.herdrDurable.deployments;
  names = builtins.attrNames deployments;
  enabled = names != [ ];
  linux = pkgs.stdenv.hostPlatform.isLinux;
  package = dotfilesInputs.self.packages.${pkgs.stdenv.hostPlatform.system}.herdr;
  configRoot = "${config.xdg.configHome}/herdr-durable";
  stateRoot = "${config.xdg.stateHome}/herdr-durable";
  protected = [
    configRoot
    stateRoot
    "${config.xdg.configHome}/dstack"
    "${config.xdg.configHome}/gh"
    "${config.xdg.stateHome}/dstack"
    "${config.home.homeDirectory}/.pi/agent"
  ]
  ++ map builtins.dirOf (
    builtins.filter (path: path != null) [
      config.my.ai.openrouterKeyFile
      config.my.ai.opencodeKeyFile
    ]
  );
in
{
  options.services.herdrDurable.deployments = lib.mkOption {
    default = { };
    description = "Explicit independent Linux Herdr Durable instances. An empty registry starts no service. Identity, domain, grants, and local SQLite roots belong to each private Host JSON, never the billing profile.";
    type = lib.types.attrsOf (
      lib.types.submodule (
        { name, ... }: {
          options.hostConfigFile = lib.mkOption {
            type = lib.types.strMatching "/[^\n\r]+";
            default = "${configRoot}/${name}/host.json";
            description = "Private runtime Host JSON inside the shared protected deployment config root. No credentials or Host JSON are copied into the Nix store.";
          };
        }
      )
    );
  };

  config = lib.mkMerge [
    {
      assertions = [
        {
          assertion = !enabled || linux;
          message = "Herdr Durable deployments require Linux.";
        }
        {
          assertion =
            builtins.length names <= 16
            && builtins.all (name: builtins.match "[a-z0-9][a-z0-9-]{0,23}" name != null) names;
          message = "Herdr Durable supports at most 16 deployment names of 1 to 24 lowercase letters, digits, or hyphens.";
        }
        {
          assertion = builtins.all (
            name: !(lib.hasPrefix "/nix/store/" deployments.${name}.hostConfigFile)
          ) names;
          message = "Herdr Durable Host JSON must be a private runtime file, not a Nix store path.";
        }
        {
          assertion =
            builtins.length (lib.unique (map (name: deployments.${name}.hostConfigFile) names))
            == builtins.length names;
          message = "Each Herdr Durable deployment requires a distinct private Host JSON.";
        }
        {
          assertion = builtins.all (
            name:
            let
              path = deployments.${name}.hostConfigFile;
            in
            lib.hasPrefix "${configRoot}/" path
            && builtins.stringLength path <= 4095
            && !(builtins.any (part: part == "." || part == "..") (lib.splitString "/" path))
          ) names;
          message = "Herdr Durable Host JSON must stay inside the protected deployment config root without traversal.";
        }
      ];
    }
    (lib.mkIf (enabled && linux) {
      systemd.user.services = lib.mapAttrs' (
        name: deployment:
        lib.nameValuePair "herdr-durable-${name}" {
          Unit.Description = "Independent Herdr Durable instance ${name}";
          Service = {
            ExecStart = "${package}/bin/herdr server";
            WorkingDirectory = "%h";
            Restart = "no";
            KillMode = "mixed";
            TimeoutStopSec = 90;
            UMask = "0077";
            NoNewPrivileges = true;
            RuntimeDirectory = "herdr-durable-${name}";
            RuntimeDirectoryMode = "0700";
            UnsetEnvironment = [
              "HERDR_SESSION"
              "HERDR_ENV"
              "HERDR_WORKSPACE_ID"
              "HERDR_PANE_ID"
              "HERDR_TAB_ID"
              "HERDR_SERVER_CONTEXT"
              "HERDR_DURABLE_HOST_CONFIG_SHA256"
              "HERDR_DURABLE_HOST_EXECUTABLE"
            ];
            Environment =
              map (value: builtins.toJSON (lib.replaceStrings [ "%" ] [ "%%" ] value)) [
                "HERDR_DURABLE_HOST_CONFIG=${deployment.hostConfigFile}"
                "HERDR_CONFIG_PATH=${pkgs.writeText "herdr-durable-config.toml" "onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n"}"
                "XDG_CONFIG_HOME=${configRoot}/${name}"
                "XDG_STATE_HOME=${stateRoot}/${name}"
                "XDG_CACHE_HOME=${config.xdg.cacheHome}/herdr-durable/${name}"
                "DSTACK_STATE_DIR=${config.xdg.stateHome}/dstack"
                "DSTACK_HOST_MODE=deployment"
                "DSTACK_PROTECTED_PATHS=${builtins.toJSON protected}"
              ]
              ++ map builtins.toJSON [
                "HERDR_SOCKET_PATH=%t/herdr-durable-${name}/api.sock"
                "HERDR_CLIENT_SOCKET_PATH=%t/herdr-durable-${name}/client.sock"
              ];
          };
          Install.WantedBy = [ "default.target" ];
        }
      ) deployments;
    })
  ];
}
