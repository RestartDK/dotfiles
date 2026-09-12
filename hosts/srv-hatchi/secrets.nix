{
  inputs,
  config,
  lib,
  ...
}:
let
  onePassword = config.services.onepassword-secrets;
  afterSops = {
    requires = [ "sops-install-secrets.service" ];
    after = [ "sops-install-secrets.service" ];
  };
in
{
  imports = [
    inputs.sops-nix.nixosModules.sops
    inputs.opnix.nixosModules.default
  ];
  services.onepassword-secrets = {
    enable = lib.mkDefault (onePassword.secrets != { } || onePassword.configFiles != [ ]);
    tokenFile = lib.mkIf onePassword.enable config.sops.secrets.opnix-token.path;
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
    secrets.opnix-token = lib.mkIf onePassword.enable {
      group = "onepassword-secrets";
      mode = "0640";
      restartUnits = [ "opnix-secrets.service" ];
    };
  };
  systemd.services = lib.mkIf onePassword.enable {
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
}
