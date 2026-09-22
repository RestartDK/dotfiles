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
      system = "aarch64-darwin";
      skillsPath = "config/agents/skills";
      claude = true;
    }
    {
      home = macHome "dkumlin-twin-macbook-pro";
      profile = "personal";
      system = "aarch64-darwin";
      skillsPath = "config/agents/skills";
      claude = true;
    }
    {
      home = self.homeConfigurations.twin.config;
      profile = "work";
      system = "x86_64-linux";
      skillsPath = "config/pi/agent/skills-twin";
      claude = false;
    }
    {
      home = cobb;
      profile = "work";
      system = "x86_64-linux";
      skillsPath = "config/pi/agent/skills-twin";
      claude = false;
    }
  ];
in
assert builtins.all (
  {
    claude,
    home,
    profile,
    skillsPath,
    system,
  }:
  home.my.ai.profile == profile
  &&
    home.xdg.configFile."dstack/models.json".source
    == home.lib.file.mkOutOfStoreSymlink "${home.my.liveConfig.repoRoot}/config/agents/model-profiles/${profile}.json"
  &&
    home.home.file.".agents/skills".source
    == home.lib.file.mkOutOfStoreSymlink "${home.my.liveConfig.repoRoot}/${skillsPath}"
  &&
    home.home.file.".agents/agents".source
    == home.lib.file.mkOutOfStoreSymlink "${home.my.liveConfig.repoRoot}/config/agents/agents"
  && (home.home.file ? ".claude/skills") == claude
  && !(home.home.file ? ".pi/agent/skills")
  && !(home.home.file ? ".codex/skills")
  && !(home.xdg.configFile ? "opencode/skills")
  && !(home.xdg.configFile ? "agents/skills")
  && !(home.xdg.configFile ? "agents/agents")
  &&
    home.home.file.".pi/agent/lib".source
    == home.lib.file.mkOutOfStoreSymlink "${home.my.liveConfig.repoRoot}/config/pi/agent/lib"
  && builtins.any (
    package:
    package.drvPath == self.packages.${system}.pi-profiled.drvPath
    || pkgs.lib.hasInfix (builtins.unsafeDiscardStringContext "${
      self.packages.${system}.pi-profiled
    }/bin/pi") (package.text or "")
  ) home.home.packages
  && !(home.home.file ? ".pi/agent/auth.json")
) owners;
pkgs.runCommand "agent-profile-tests"
  {
    nativeBuildInputs = [
      pkgs.bun
      self.packages.${pkgs.stdenv.hostPlatform.system}.pi-profiled
    ];
  }
  ''
    export HOME=$TMPDIR
    cd ${../.}
    bun test tests/agent-profiles
    touch $out
  ''
