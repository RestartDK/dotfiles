{ userName }:
{
  config,
  ...
}:
let
  home = config.users.users.${userName}.home;
in
{
  imports = [ ../modules/secrets.nix ];

  my.secrets = {
    inherit userName;
    keys.openrouterApiKey = {
      reference = "op://abdtxvj44nyypdbkbehdg4qbfq/jrx6q4cloqzx25ciits7qeipym/credential";
      path = "${home}/.opnix-openrouter-api-key";
      consumers.piKeyFile = true;
    };
  };
}
