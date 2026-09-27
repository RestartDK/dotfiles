{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.deploy;
in
{
  options.my.deploy = {
    userName = lib.mkOption {
      type = lib.types.str;
      default = "deploy";
      example = "deploy";
      description = "Account the deployment system uses for unattended activations.";
    };
  };

  config = {
    users.groups.${cfg.userName} = { };

    users.users.${cfg.userName} = {
      isSystemUser = true;
      group = cfg.userName;
      createHome = true;
      home = "/var/lib/${cfg.userName}";
      shell = pkgs.bashInteractive;
      openssh.authorizedKeys.keyFiles = [ ../../config/ssh/public-keys/ci-deploy.pub ];
    };

    nix.settings.trusted-users = [ cfg.userName ];

    security.sudo.extraRules = [
      {
        users = [ cfg.userName ];
        commands = [
          {
            command = "ALL";
            options = [ "NOPASSWD" ];
          }
        ];
      }
    ];
  };
}
