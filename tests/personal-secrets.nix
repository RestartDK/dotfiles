{
  pkgs,
  self,
  inputs,
  privateValues,
}:
let
  mac = self.darwinConfigurations.dkumlin-macbook-pro.config;
  nana = self.nixosConfigurations.srv-nana.config;
  twinMac = self.darwinConfigurations.dkumlin-twin-macbook-pro.config;
  personalHosts = [
    {
      config = mac;
      userName = "danielkumlin";
      group = "staff";
      secrets = [
        "opencodeApiKey"
        "openrouterApiKey"
      ];
    }
    {
      config = nana;
      userName = "dkumlin";
      group = nana.users.users.dkumlin.group;
      secrets = [
        "homelabSshKey"
        "mangyApiKey"
        "opencodeApiKey"
        "openrouterApiKey"
      ];
    }
    {
      config = twinMac;
      userName = "danielkumlin";
      group = "staff";
      secrets = [
        "opencodeApiKey"
        "openrouterApiKey"
      ];
    }
  ];
  cobb =
    (inputs.home-manager.lib.homeManagerConfiguration {
      pkgs = self.nixosConfigurations.srv-nana.pkgs;
      modules = [
        self.homeManagerModules.default
        {
          my.ai.profile = "work";
          home = {
            username = "daniel";
            homeDirectory = "/home/daniel";
            stateVersion = "26.05";
          };
        }
      ];
    }).config;
  nativeHost =
    if pkgs.stdenv.hostPlatform.isDarwin then
      builtins.head personalHosts
    else
      builtins.elemAt personalHosts 1;
  nativeHome = nativeHost.config.home-manager.users.${nativeHost.userName};
in
assert builtins.all (
  {
    config,
    userName,
    group,
    secrets,
  }:
  let
    cfg = config.services.onepassword-secrets;
    openrouter = cfg.secrets.openrouterApiKey;
    opencode = cfg.secrets.opencodeApiKey;
    home = config.home-manager.users.${userName};
    homeDir = home.home.homeDirectory;
    fleetKey = cfg.secrets.homelabSshKey or null;
    mangyKey = cfg.secrets.mangyApiKey or null;
  in
  cfg.enable
  && cfg.tokenFile == "/etc/opnix-token"
  && cfg.users == [ ]
  && builtins.attrNames cfg.secrets == secrets
  && openrouter.reference == privateValues.personalSecretReferences.openrouterApiKey
  && openrouter.path == "${homeDir}/.opnix-openrouter-api-key"
  && cfg.secretPaths.openrouterApiKey == openrouter.path
  && opencode.reference == privateValues.personalSecretReferences.opencodeApiKey
  && opencode.path == "${homeDir}/.opnix-opencode-api-key"
  && cfg.secretPaths.opencodeApiKey == opencode.path
  && (
    fleetKey == null
    || (
      fleetKey.reference == privateValues.personalSecretReferences.homelabSshKey
      && fleetKey.path == "/run/onepassword-ssh/id_ed25519"
      && cfg.secretPaths.homelabSshKey == fleetKey.path
      && fleetKey.owner == userName
      && fleetKey.group == group
      && fleetKey.mode == "0400"
    )
  )
  && (
    mangyKey == null
    || (
      mangyKey.reference == "op://Developer/Chateau mangy api key/credential"
      && mangyKey.path == "${homeDir}/.opnix-mangy-api-key"
      && cfg.secretPaths.mangyApiKey == mangyKey.path
      && mangyKey.owner == userName
      && mangyKey.group == group
      && mangyKey.mode == "0400"
    )
  )
  &&
    builtins.all (secret: secret.owner == userName && secret.group == group && secret.mode == "0400")
      [
        openrouter
        opencode
      ]
  && !(home.home.file ? ".pi/agent/auth.json")
  && !(home.home.sessionVariables ? OPENROUTER_API_KEY)
  && !(home.home.sessionVariables ? OPENCODE_API_KEY)
) personalHosts;
assert mac.launchd.daemons.opnix-secrets.serviceConfig.RunAtLoad;
assert twinMac.launchd.daemons.opnix-secrets.serviceConfig.RunAtLoad;
assert nana.systemd.services.opnix-secrets.serviceConfig.User == "root";
assert !nana.services.onepassword-secrets.systemdIntegration.enable;
assert
  let
    home = cobb;
  in
  !(home.programs ? onepassword-secrets)
  && !(home.home.file ? ".pi/agent/auth.json")
  && !(home.home.sessionVariables ? OPENROUTER_API_KEY)
  && !(home.home.sessionVariables ? OPENCODE_API_KEY)
  && pkgs.lib.hasPrefix "/nix/store/" home.home.file.".pi/agent/models.json".source
  && home.home.file.".pi/agent/models.json".source == ../config/pi/agent/models.json;
pkgs.runCommand "personal-secrets-tests"
  {
    nativeBuildInputs = [
      pkgs.bash
      pkgs.coreutils
      pkgs.jq
      self.packages.${pkgs.stdenv.hostPlatform.system}.pi
    ];
    MODELS_FILE = nativeHome.home.file.".pi/agent/models.json".source;
    BASE_MODELS = ../config/pi/agent/models.json;
    MODEL_POLICY = ../config/agents/model-profiles/personal.json;
    SECRET_PATH = nativeHost.config.services.onepassword-secrets.secretPaths.openrouterApiKey;
    OPENCODE_SECRET_PATH = nativeHost.config.services.onepassword-secrets.secretPaths.opencodeApiKey;
  }
  ''
    bash ${./personal-secrets.sh}
    touch $out
  ''
