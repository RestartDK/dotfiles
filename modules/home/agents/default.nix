{
  config,
  dotfilesInputs,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.liveConfig;
  allAgents = cfg.groups.agents;
  agentSkillsEnabled = allAgents || cfg.groups.agentSkills;
  agentSkillsPath = "config/agents/skills";
  codex = allAgents || cfg.groups.codex;
  claude = allAgents || cfg.groups.claude;
  opencode = allAgents || cfg.groups.opencode;
  pi = allAgents || cfg.groups.pi;
  piPackageNames = import ../../../packages/pi-package-names.nix;
  piPackages = dotfilesInputs.self.packages.${pkgs.stdenv.hostPlatform.system};
  link = path: config.lib.file.mkOutOfStoreSymlink "${cfg.repoRoot}/${path}";
  file = path: {
    source = link path;
    force = true;
  };
  dir = path: {
    source = link path;
    recursive = false;
    force = true;
  };
  piPackage = name: {
    source = "${piPackages.${name}}/lib/node_modules/${name}";
    recursive = false;
    force = true;
  };
  piPackageFiles = builtins.listToAttrs (
    map (name: {
      name = ".pi/agent/packages/${name}";
      value = piPackage name;
    }) piPackageNames
  );
in
{
  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf agentSkillsEnabled {
        home.file.".agents/.skill-lock.json" = file "config/agents/.skill-lock.json";
        home.file.".agents/skills" = dir agentSkillsPath;
        home.file.".agents/agents" = dir "config/agents/agents";
      })

      (lib.mkIf (agentSkillsEnabled || pi) {
        xdg.configFile."dstack/models.json" =
          file "config/agents/model-profiles/${config.my.ai.profile}.json";
      })

      (lib.mkIf (pi && !agentSkillsEnabled) {
        home.file.".agents/skills" = dir cfg.piSkillsPath;
        home.file.".agents/agents" = dir "config/agents/agents";
      })

      (lib.mkIf codex {
        home.file.".codex/AGENTS.md" = file "config/codex/AGENTS.md";
        home.file.".codex/hooks.json" = file "config/codex/hooks.json";
        home.file.".codex/herdr-agent-state.sh" = file "config/codex/herdr-agent-state.sh";
        home.file.".codex/rules/default.rules" = file "config/codex/rules/default.rules";
      })

      (lib.mkIf claude {
        home.file.".claude/settings.json" = file "config/claude/settings.json";
        home.file.".claude/hooks/herdr-agent-state.sh" = file "config/claude/hooks/herdr-agent-state.sh";
        home.file.".claude/skills" = lib.mkIf agentSkillsEnabled (dir agentSkillsPath);
      })

      (lib.mkIf opencode {
        xdg.configFile."opencode/opencode.json" = file "config/opencode/opencode.json";
        xdg.configFile."opencode/package.json" = file "config/opencode/package.json";
        xdg.configFile."opencode/plugins" = dir "config/opencode/plugins";
      })

      (lib.mkIf pi {
        home.file.".pi/agent/AGENTS.md" = file "config/pi/agent/AGENTS.md";
        home.file.".pi/agent/keybindings.json" = file "config/pi/agent/keybindings.json";
        home.file.".pi/agent/settings.json" = file cfg.piSettingsFile;
        home.file.".pi/agent/models.json" = file "config/pi/agent/models.json";
        home.file.".pi/agent/mcp.json" = file "config/pi/agent/mcp.json";
        home.file.".pi/agent/extensions" = dir "config/pi/agent/extensions";
        home.file.".pi/agent/lib" = dir "config/pi/agent/lib";
        home.file.".pi/agent/bin" = dir "config/pi/agent/bin";
        home.file.".pi/agent/prompts" = dir "config/pi/agent/prompts";
        home.file.".pi/agent/themes" = dir "config/pi/agent/themes";
      })

      (lib.mkIf pi {
        home.file = piPackageFiles;
      })

    ]
  );
}
