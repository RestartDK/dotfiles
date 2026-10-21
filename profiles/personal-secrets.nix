{ userName }:
{
  config,
  network,
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
      reference = network.personalSecretReferences.openrouterApiKey;
      path = "${home}/.opnix-openrouter-api-key";
    };
    keys.opencodeApiKey = {
      reference = network.personalSecretReferences.opencodeApiKey;
      path = "${home}/.opnix-opencode-api-key";
    };
    consumers = {
      piKeyFile = "openrouterApiKey";
      piOpencodeKeyFile = "opencodeApiKey";
    };
  };
}
