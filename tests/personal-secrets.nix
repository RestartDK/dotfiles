{
  pkgs,
  self,
  inputs,
}:
let
  privateValues = import inputs.private;
  mac = self.darwinConfigurations.dkumlin-macbook-pro.config;
  nana = self.nixosConfigurations.srv-nana.config;
  twinMac = self.darwinConfigurations.dkumlin-twin-macbook-pro.config;
  twin = self.homeConfigurations.twin.config;
  personalHosts = [
    {
      config = mac;
      userName = "danielkumlin";
      group = "staff";
    }
    {
      config = nana;
      userName = "dkumlin";
      group = nana.users.users.dkumlin.group;
    }
    {
      config = twinMac;
      userName = "danielkumlin";
      group = "staff";
    }
  ];
  cobb =
    hostName:
    (inputs.home-manager.lib.homeManagerConfiguration {
      pkgs = self.nixosConfigurations.srv-nana.pkgs;
      extraSpecialArgs.osConfig.networking.hostName = hostName;
      modules = [
        self.homeManagerModules.cobb-daniel
        {
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
  }:
  let
    cfg = config.services.onepassword-secrets;
    openrouter = cfg.secrets.openrouterApiKey;
    opencode = cfg.secrets.opencodeApiKey;
    home = config.home-manager.users.${userName};
    homeDir = home.home.homeDirectory;
  in
  cfg.enable
  && cfg.tokenFile == "/etc/opnix-token"
  && cfg.users == [ ]
  &&
    builtins.attrNames cfg.secrets == [
      "opencodeApiKey"
      "openrouterApiKey"
    ]
  && openrouter.reference == privateValues.personalSecretReferences.openrouterApiKey
  && openrouter.path == "${homeDir}/.opnix-openrouter-api-key"
  && cfg.secretPaths.openrouterApiKey == openrouter.path
  && opencode.reference == privateValues.personalSecretReferences.opencodeApiKey
  && opencode.path == "${homeDir}/.opnix-opencode-api-key"
  && cfg.secretPaths.opencodeApiKey == opencode.path
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
assert !(twin.programs ? onepassword-secrets);
assert builtins.all
  (
    hostName:
    let
      home = cobb hostName;
    in
    !(home.programs ? onepassword-secrets)
    && !(home.home.file ? ".pi/agent/auth.json")
    && !(home.home.sessionVariables ? OPENROUTER_API_KEY)
    && !(home.home.sessionVariables ? OPENCODE_API_KEY)
    && pkgs.lib.hasPrefix "/nix/store/" home.home.file.".pi/agent/models.json".source
    && home.home.file.".pi/agent/models.json".source == ../config/pi/agent/models.json
  )
  [
    "titan"
    "titan-2"
    "monster"
  ];
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
