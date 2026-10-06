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
  codex = allAgents || cfg.groups.codex;
  claude = allAgents || cfg.groups.claude;
  opencode = allAgents || cfg.groups.opencode;
  pi = allAgents || cfg.groups.pi;
  piPackageNames = import ../../../packages/pi-package-names.nix;
  piMcpSource =
    if config.my.ai.profile == "work" then
      ../../../config/pi/agent/mcp-work.json
    else
      ../../../config/pi/agent/mcp.json;
  piPackages = dotfilesInputs.self.packages.${pkgs.stdenv.hostPlatform.system};
  # One store copy of the whole agent tree. Home Manager links each
  # subdirectory separately, and the extensions import ../../lib/model-policy,
  # which only resolves while lib stays a sibling inside the same copy.
  piAgentRoot = pkgs.copyPathToStore ../../../config/pi/agent;
  # Keep the result a path. Home Manager copies paths into their own store
  # paths, but interpolating the flake root into a string instead makes the
  # whole tree an input to the produced derivation, which uncaches every host
  # on every commit.
  configPath = relative: ../../../. + "/${relative}";
  piPackage = name: {
    source = "${piPackages.${name}}/lib/node_modules/${name}";
    recursive = false;
    force = true;
  };
  piPackageFiles = builtins.listToAttrs (
    map (name: {
      name = ".pi/agent/packages/${name}";
      value = piPackage name;
    }) (piPackageNames ++ [ "pi-claude-task" ])
  );
  keyedProviders = lib.filterAttrs (_: path: path != null) {
    openrouter = config.my.ai.openrouterKeyFile;
    "opencode-go" = config.my.ai.opencodeKeyFile;
  };
  modelsFile =
    if keyedProviders == { } then
      {
        source = ../../../config/pi/agent/models.json;
        force = true;
      }
    else
      let
        models = builtins.fromJSON (builtins.readFile ../../../config/pi/agent/models.json);
        providerKeys = lib.mapAttrsToList (provider: path: {
          name = provider;
          value.apiKey = "!${pkgs.coreutils}/bin/cat ${lib.escapeShellArg path}";
        }) keyedProviders;
      in
      {
        source = (pkgs.formats.json { }).generate "pi-models.json" (
          lib.recursiveUpdate models { providers = builtins.listToAttrs providerKeys; }
        );
        force = true;
      };
in
{
  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf agentSkillsEnabled {
        home.file.".agents/.skill-lock.json" = {
          source = ../../../config/agents/.skill-lock.json;
          force = true;
        };
        home.file.".agents/skills" = {
          source = ../../../config/agents/skills;
          recursive = true;
          force = true;
        };
        home.file.".agents/agents" = {
          source = ../../../config/agents/agents;
          recursive = true;
          force = true;
        };
      })

      (lib.mkIf (agentSkillsEnabled || pi) {
        xdg.configFile."dstack/models.json" = {
          source = ../../../config/agents/model-profiles/${config.my.ai.profile}.json;
          force = true;
        };
      })

      (lib.mkIf (pi && !agentSkillsEnabled) {
        home.file.".agents/skills" = {
          source = configPath cfg.piSkillsPath;
          recursive = true;
          force = true;
        };
        home.file.".agents/agents" = {
          source = ../../../config/agents/agents;
          recursive = true;
          force = true;
        };
      })

      (lib.mkIf codex {
        home.file.".codex/AGENTS.md" = {
          source = ../../../config/codex/AGENTS.md;
          force = true;
        };
        home.file.".codex/hooks.json" = {
          source = ../../../config/codex/hooks.json;
          force = true;
        };
        home.file.".codex/herdr-agent-state.sh" = {
          source = ../../../config/codex/herdr-agent-state.sh;
          force = true;
        };
        home.file.".codex/rules/default.rules" = {
          source = ../../../config/codex/rules/default.rules;
          force = true;
        };
      })

      (lib.mkIf claude {
        home.file.".claude/settings.json" = {
          source = ../../../config/claude/settings.json;
          force = true;
        };
        home.file.".claude/hooks/herdr-agent-state.sh" = {
          source = ../../../config/claude/hooks/herdr-agent-state.sh;
          force = true;
        };
        home.file.".claude/hooks/usage-statusline.py" = {
          source = ../../../config/claude/hooks/usage-statusline.py;
          force = true;
        };
        home.file.".claude/skills" = lib.mkIf agentSkillsEnabled {
          source = ../../../config/agents/skills;
          recursive = true;
          force = true;
        };
      })

      (lib.mkIf opencode {
        xdg.configFile."opencode/opencode.json" = {
          source = ../../../config/opencode/opencode.json;
          force = true;
        };
        xdg.configFile."opencode/package.json" = {
          source = ../../../config/opencode/package.json;
          force = true;
        };
        xdg.configFile."opencode/plugins" = {
          source = ../../../config/opencode/plugins;
          recursive = true;
          force = true;
        };
      })

      (lib.mkIf pi {
        home.file.".pi/agent/AGENTS.md" = {
          source = ../../../config/pi/agent/AGENTS.md;
          force = true;
        };
        home.file.".pi/agent/keybindings.json" = {
          source = ../../../config/pi/agent/keybindings.json;
          force = true;
        };
        home.file.".pi/agent/settings.json" = {
          source = configPath cfg.piSettingsFile;
          force = true;
        };
        home.file.".pi/agent/models.json" = modelsFile;
        home.file.".pi/agent/mcp.json" = {
          source = piMcpSource;
          force = true;
        };
        home.file.".pi/agent/extensions" = {
          source = "${piAgentRoot}/extensions";
          recursive = true;
          force = true;
        };
        home.file.".pi/agent/lib" = {
          source = "${piAgentRoot}/lib";
          recursive = true;
          force = true;
        };
        home.file.".pi/agent/bin" = {
          source = "${piAgentRoot}/bin";
          recursive = true;
          force = true;
        };
        home.file.".pi/agent/prompts" = {
          source = "${piAgentRoot}/prompts";
          recursive = true;
          force = true;
        };
        home.file.".pi/agent/themes" = {
          source = "${piAgentRoot}/themes";
          recursive = true;
          force = true;
        };
      })

      (lib.mkIf pi {
        home.file = piPackageFiles;
      })

    ]
  );
}
