{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.my.secrets;
  isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
  user = config.users.users.${cfg.userName};
  keyModule = { ... }: {
    options = {
      reference = lib.mkOption {
        type = lib.types.strMatching "op://.+/.+/.+";
        description = "1Password reference for the key.";
      };
      path = lib.mkOption {
        type = lib.types.strMatching "/.+";
        description = "Runtime file that holds the key.";
      };
      mode = lib.mkOption {
        type = lib.types.str;
        default = "0400";
        description = "Mode of the runtime file.";
      };
      owner = lib.mkOption {
        type = lib.types.str;
        default = cfg.userName;
        description = "Owner of the runtime file.";
      };
      group = lib.mkOption {
        type = lib.types.str;
        default = if isDarwin then "staff" else user.group;
        description = "Group of the runtime file.";
      };
    };
  };
in
{
  options.my.secrets = {
    userName = lib.mkOption {
      type = lib.types.str;
      description = "User whose runtime key files are configured.";
    };
    tokenFile = lib.mkOption {
      type = lib.types.strMatching "/.+";
      description = "1Password service-account token file that opnix reads. Provision it before the first fetch.";
    };
    keys = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule keyModule);
      default = { };
      description = "Keys delivered from 1Password to runtime files. The attribute name is the opnix secret name.";
    };
    paths = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      readOnly = true;
      description = "Runtime file for every declared key, for consumers to read.";
    };
  };

  config = lib.mkIf (cfg.keys != { }) {
    services.onepassword-secrets = {
      enable = true;
      tokenFile = cfg.tokenFile;
      secrets = lib.mapAttrs (_: key: {
        reference = key.reference;
        path = key.path;
        owner = key.owner;
        group = key.group;
        mode = key.mode;
      }) cfg.keys;
    };

    my.secrets.paths = lib.genAttrs (lib.attrNames cfg.keys) (
      name: config.services.onepassword-secrets.secretPaths.${name}
    );

    environment.systemPackages = lib.optionals isDarwin [
      inputs.opnix.packages.${pkgs.stdenv.hostPlatform.system}.default
    ];

    assertions = [
      {
        assertion = !(lib.hasPrefix "${builtins.storeDir}/" cfg.tokenFile);
        message = "my.secrets.tokenFile must live outside the Nix store";
      }
    ]
    ++ lib.mapAttrsToList (name: key: {
      assertion = !(lib.hasPrefix "${builtins.storeDir}/" key.path);
      message = "my.secrets.keys.${name}.path must live outside the Nix store";
    }) cfg.keys;
  };
}
