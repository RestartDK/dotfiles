{
  inputs,
  config,
  lib,
  ...
}:
{
  imports = [ inputs.sops-nix.nixosModules.sops ];
  sops = {
    useSystemdActivation = true;
    defaultSopsFile = "/var/lib/sops/srv-hatchi.yaml";
    validateSopsFiles = false;
    age = {
      keyFile = "/var/lib/sops/age/keys.txt";
      sshKeyPaths = [ ];
    };
    gnupg.sshKeyPaths = [ ];
  };
  assertions = lib.mapAttrsToList (name: secret: {
    assertion = lib.hasPrefix "/run/secrets/" secret.path;
    message = "Hatchi secret ${name} must be a runtime file";
  }) config.sops.secrets;
}
