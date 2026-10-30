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
  repoCommands = pkgs.callPackage ../packages/repo-exec { };
  settingsChecks =
    pkgs.lib.concatMapStringsSep "\n"
      (
        { profile, file }:
        let
          home =
            (inputs.home-manager.lib.homeManagerConfiguration {
              inherit pkgs;
              extraSpecialArgs.dotfilesInputs = inputs;
              modules = [
                ../modules/home/live-config-options.nix
                ../modules/home/shell
                ../modules/home/agents
                {
                  my.ai.profile = profile;
                  my.liveConfig = {
                    enable = true;
                    piSettingsFile = file;
                    groups.pi = true;
                  };
                  home = {
                    username = "profile-test";
                    homeDirectory = "/home/profile-test";
                    stateVersion = "26.05";
                  };
                }
              ];
            }).config;
          settings = home.home.file.".pi/agent/settings.json".source;
          settingsClosure = pkgs.closureInfo { rootPaths = [ settings ]; };
          base = ../. + "/${file}";
          baseSettings = builtins.fromJSON (builtins.readFile base);
          usesPackagedShell = !(baseSettings ? shellPath);
          expectedShell = baseSettings.shellPath or "${repoCommands}/bin/repo-bash";
        in
        assert home.home.file.".local/bin/repo-bash".source == "${repoCommands}/bin/repo-bash";
        assert home.home.file.".local/bin/repo-exec".source == "${repoCommands}/bin/repo-exec";
        assert builtins.any (package: package.drvPath == repoCommands.drvPath) home.home.packages;
        ''
          echo "Checking generated ${profile} settings from ${file}"
          jq --exit-status --arg shell "${expectedShell}" \
            '.shellPath == $shell' ${settings}
          jq --exit-status --slurpfile base ${base} \
            'del(.shellPath) == ($base[0] | del(.shellPath))' ${settings}
          ${pkgs.lib.optionalString usesPackagedShell ''
            test -x "$(jq --raw-output '.shellPath' ${settings})"
            grep -Fx -- "${repoCommands}" ${settingsClosure}/store-paths
          ''}
          if grep -Fx -- "${builtins.unsafeDiscardStringContext self.outPath}" ${settingsClosure}/store-paths; then
            echo "Pi settings closure includes the whole flake source" >&2
            exit 1
          fi
        ''
      )
      [
        {
          profile = "personal";
          file = "config/pi/agent/settings.json";
        }
        {
          profile = "work";
          file = "config/pi/agent/settings-work.json";
        }
        {
          profile = "personal";
          file = "tests/agent-profiles/settings-override.json";
        }
      ];
  personalMcp = builtins.fromJSON (builtins.readFile ../config/pi/agent/mcp.json);
  workMcp = builtins.fromJSON (builtins.readFile ../config/pi/agent/mcp-work.json);
  owners = [
    {
      home = macHome "dkumlin-macbook-pro";
      profile = "personal";
      system = "aarch64-darwin";
      skillsSource = ../config/agents/skills;
      claude = true;
    }
    {
      home = macHome "dkumlin-twin-macbook-pro";
      profile = "personal";
      system = "aarch64-darwin";
      skillsSource = ../config/agents/skills;
      claude = true;
    }
    {
      home = cobb;
      profile = "work";
      system = "x86_64-linux";
      skillsSource = ../config/agents/skills;
      claude = false;
    }
  ];
in
assert builtins.all (
  {
    claude,
    home,
    profile,
    skillsSource,
    system,
  }:
  home.my.ai.profile == profile
  && home.programs.direnv.enable
  && !home.programs.direnv.enableZshIntegration
  &&
    home.programs.direnv.config.whitelist.prefix == [ "${home.home.homeDirectory}/.herdr/worktrees/" ]
  && pkgs.lib.hasPrefix "/nix/store/" home.xdg.configFile."dstack/models.json".source
  &&
    home.xdg.configFile."dstack/models.json".source
    == ../config/agents/model-profiles + "/${profile}.json"
  && pkgs.lib.hasPrefix "/nix/store/" home.home.file.".agents/skills".source
  && home.home.file.".agents/skills".source == skillsSource
  && home.home.file.".agents/skills".recursive == true
  && pkgs.lib.hasPrefix "/nix/store/" home.home.file.".agents/agents".source
  && home.home.file.".agents/agents".source == ../config/agents/agents
  && home.home.file.".agents/agents".recursive == true
  && (home.home.file ? ".claude/skills") == claude
  && !(home.home.file ? ".pi/agent/skills")
  && !(home.home.file ? ".codex/skills")
  && !(home.xdg.configFile ? "opencode/skills")
  && !(home.xdg.configFile ? "agents/skills")
  && !(home.xdg.configFile ? "agents/agents")
  && pkgs.lib.hasPrefix "/nix/store/" home.home.file.".pi/agent/lib".source
  # The extensions import ../../lib, so lib has to be a sibling inside the same
  # store copy rather than its own link.
  &&
    builtins.dirOf home.home.file.".pi/agent/lib".source
    == builtins.dirOf home.home.file.".pi/agent/extensions".source
  && home.home.file.".pi/agent/lib".recursive == true
  && builtins.any (
    package:
    package.drvPath == self.packages.${system}.pi.drvPath
    || pkgs.lib.hasInfix (builtins.unsafeDiscardStringContext "${self.packages.${system}.pi}/bin/pi") (
      package.text or ""
    )
  ) home.home.packages
  &&
    home.home.file.".pi/agent/mcp.json".source
    == (if profile == "work" then ../config/pi/agent/mcp-work.json else ../config/pi/agent/mcp.json)
  && !(home.home.file ? ".pi/agent/auth.json")
) owners;
assert !(personalMcp.mcpServers ? figma);
assert !(workMcp.mcpServers ? figma);
pkgs.runCommand "agent-profile-tests"
  {
    nativeBuildInputs = [
      pkgs.bun
      pkgs.jq
      self.packages.${pkgs.stdenv.hostPlatform.system}.pi
    ];
  }
  ''
    export HOME=$TMPDIR
    ${settingsChecks}
    cp -R ${../config} $TMPDIR/config
    cp -R ${../tests} $TMPDIR/tests
    cd $TMPDIR
    bun test tests/agent-profiles
    touch $out
  ''
