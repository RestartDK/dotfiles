{
  pkgs,
  self,
  inputs,
}:
let
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
    secret = cfg.secrets.openrouterApiKey;
    home = config.home-manager.users.${userName};
  in
  cfg.enable
  && cfg.tokenFile == "/etc/opnix-token"
  && cfg.users == [ ]
  && builtins.attrNames cfg.secrets == [ "openrouterApiKey" ]
  && secret.reference == "op://abdtxvj44nyypdbkbehdg4qbfq/jrx6q4cloqzx25ciits7qeipym/credential"
  && secret.path == "${home.home.homeDirectory}/.opnix-openrouter-api-key"
  && cfg.secretPaths.openrouterApiKey == secret.path
  && secret.owner == userName
  && secret.group == group
  && secret.mode == "0400"
  && !(home.home.file ? ".pi/agent/auth.json")
  && !(home.home.sessionVariables ? OPENROUTER_API_KEY)
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
    &&
      home.home.file.".pi/agent/models.json".source
      == home.lib.file.mkOutOfStoreSymlink "${home.my.liveConfig.repoRoot}/config/pi/agent/models.json"
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
      inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.pi
    ];
    MODELS_FILE = nativeHome.home.file.".pi/agent/models.json".source;
    BASE_MODELS = ../config/pi/agent/models.json;
    SECRET_PATH = nativeHost.config.services.onepassword-secrets.secretPaths.openrouterApiKey;
  }
  ''
    bash ${./personal-secrets.sh}
    touch $out
  ''
