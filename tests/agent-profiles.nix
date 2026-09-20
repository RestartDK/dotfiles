{
  pkgs,
  self,
  inputs,
}:
let
  macHome = name: self.darwinConfigurations.${name}.config.home-manager.users.danielkumlin;
  cobb =
    (inputs.home-manager.lib.homeManagerConfiguration {
      pkgs = self.nixosConfigurations.srv-nana.pkgs;
      extraSpecialArgs.osConfig.networking.hostName = "titan";
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
  owners = [
    {
      home = macHome "dkumlin-macbook-pro";
      profile = "personal";
    }
    {
      home = macHome "dkumlin-twin-macbook-pro";
      profile = "work";
    }
    {
      home = self.homeConfigurations.twin.config;
      profile = "work";
    }
    {
      home = cobb;
      profile = "work";
    }
  ];
in
assert builtins.all (
  { home, profile }:
  home.my.liveConfig.agentProfile == profile
  &&
    home.xdg.configFile."dstack/models.json".source
    == home.lib.file.mkOutOfStoreSymlink "${home.my.liveConfig.repoRoot}/config/agents/model-profiles/${profile}.json"
  &&
    home.home.file.".agents/agents".source
    == home.lib.file.mkOutOfStoreSymlink "${home.my.liveConfig.repoRoot}/config/agents/agents"
  && !(home.home.file ? ".pi/agent/auth.json")
) owners;
pkgs.runCommand "agent-profile-tests" { nativeBuildInputs = [ pkgs.bun ]; } ''
  export HOME=$TMPDIR
  cd ${../.}
  bun test tests/agent-profiles
  touch $out
''
