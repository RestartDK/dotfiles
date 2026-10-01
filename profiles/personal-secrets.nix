{ userName }:
{
  config,
  ...
}:
let
  home = config.users.users.${userName}.home;
in
{
  imports = [
    ../modules/secrets
    ../modules/secrets/consumers.nix
  ];

  my.secrets = {
    inherit userName;
    tokenFile = "/etc/opnix-token";
    keys.openrouterApiKey = {
      reference = "op://abdtxvj44nyypdbkbehdg4qbfq/jrx6q4cloqzx25ciits7qeipym/credential";
      path = "${home}/.opnix-openrouter-api-key";
    };
    consumers.piKeyFile = "openrouterApiKey";
  };
}
