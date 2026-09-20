{ userName }:
{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:

let
  user = config.users.users.${userName};
  secrets = config.services.onepassword-secrets;
  models = builtins.fromJSON (builtins.readFile ../config/pi/agent/models.json);
in
{
  services.onepassword-secrets = {
    enable = true;
    tokenFile = "/etc/opnix-token";
    secrets.openrouterApiKey = {
      reference = "op://abdtxvj44nyypdbkbehdg4qbfq/jrx6q4cloqzx25ciits7qeipym/credential";
      path = "${user.home}/.opnix-openrouter-api-key";
      owner = userName;
      group = if pkgs.stdenv.hostPlatform.isDarwin then "staff" else user.group;
      mode = "0400";
    };
  };

  environment.systemPackages = lib.optionals pkgs.stdenv.hostPlatform.isDarwin [
    inputs.opnix.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];

  home-manager.users.${userName}.home.file.".pi/agent/models.json".source = lib.mkForce (
    (pkgs.formats.json { }).generate "pi-personal-models.json" (
      lib.recursiveUpdate models {
        providers.openrouter.apiKey = "!${pkgs.coreutils}/bin/cat ${lib.escapeShellArg secrets.secretPaths.openrouterApiKey}";
      }
    )
  );
}
