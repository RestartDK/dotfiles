{ config, lib, ... }:

let
  cfg = config.my.liveConfig;
  allAgents = cfg.groups.agents;
  allAgentSkills = allAgents || cfg.groups.agentSkills;
  globalAgentSkills = cfg.groups.agentSkillsGlobal;
  personalAgentSkills = cfg.groups.agentSkillsPersonal;
  agentSkillsPath =
    if allAgentSkills || (globalAgentSkills && personalAgentSkills) then
      "dotfiles/agents/skills-all"
    else if globalAgentSkills then
      "dotfiles/agents/skills-global"
    else if personalAgentSkills then
      "dotfiles/agents/skills-personal"
    else
      null;
  agentSkillsEnabled = agentSkillsPath != null;
  codex = allAgents || cfg.groups.codex;
  claude = allAgents || cfg.groups.claude;
  opencode = allAgents || cfg.groups.opencode;
  pi = allAgents || cfg.groups.pi;
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
in
{
  options.my.liveConfig = {
    enable = lib.mkEnableOption "live out-of-store dotfile symlinks";

    repoRoot = lib.mkOption {
      type = lib.types.str;
      description = "Absolute path to the editable nix-config checkout on this host.";
    };

    piSettingsFile = lib.mkOption {
      type = lib.types.str;
      default = "dotfiles/pi/agent/settings.json";
      description = "Repo-relative Pi settings JSON file to link as ~/.pi/agent/settings.json.";
    };

    groups = {
      shell = lib.mkEnableOption "shell/starship config";
      git = lib.mkEnableOption "Git config";
      editors = lib.mkEnableOption "editor config";
      terminalTools = lib.mkEnableOption "terminal utility config";
      ghostty = lib.mkEnableOption "Ghostty terminal config";
      wayland = lib.mkEnableOption "Wayland desktop config";
      herdr = lib.mkEnableOption "Herdr config";
      agents = lib.mkEnableOption "all AI agent config";
      agentSkills = lib.mkEnableOption "all shared AI agent skills config";
      agentSkillsGlobal = lib.mkEnableOption "global AI agent skills config";
      agentSkillsPersonal = lib.mkEnableOption "personal AI agent skills config";
      codex = lib.mkEnableOption "Codex config";
      claude = lib.mkEnableOption "Claude config";
      opencode = lib.mkEnableOption "OpenCode config";
      pi = lib.mkEnableOption "Pi config";
      macos = lib.mkEnableOption "macOS-specific app config";
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    (lib.mkIf cfg.groups.shell {
      home.file.".zshrc" = file "dotfiles/shell/zshrc";
      xdg.configFile."starship.toml" = file "dotfiles/shell/starship.toml";
    })

    (lib.mkIf cfg.groups.git {
      xdg.configFile."git/ignore" = file "dotfiles/git/ignore";
    })

    (lib.mkIf cfg.groups.editors {
      xdg.configFile."nvim" = dir "dotfiles/nvim";
    })

    (lib.mkIf cfg.groups.terminalTools {
      xdg.configFile."btop/btop.conf" = file "dotfiles/btop/btop.conf";
      xdg.configFile."hunk/config.toml" = file "dotfiles/hunk/config.toml";
      xdg.configFile."thefuck/settings.py" = file "dotfiles/thefuck/settings.py";
    })

    (lib.mkIf cfg.groups.ghostty {
      xdg.configFile."ghostty" = dir "dotfiles/ghostty";
    })

    (lib.mkIf cfg.groups.wayland {
      xdg.configFile."hypr" = dir "dotfiles/hypr";
      xdg.configFile."waybar" = dir "dotfiles/waybar";
      xdg.configFile."wlogout" = dir "dotfiles/wlogout";
      # Hyprtoolkit/Hyprlauncher only search ~/.local/share/icons and
      # /usr/share/icons, not NixOS' /run/current-system/sw/share/icons.
      home.file.".local/share/icons/hicolor" = {
        source = config.lib.file.mkOutOfStoreSymlink "/run/current-system/sw/share/icons/hicolor";
        force = true;
      };
      home.file.".local/share/icons/Papirus" = {
        source = config.lib.file.mkOutOfStoreSymlink "/run/current-system/sw/share/icons/Papirus";
        force = true;
      };
      home.file.".local/share/icons/breeze" = {
        source = config.lib.file.mkOutOfStoreSymlink "/run/current-system/sw/share/icons/breeze";
        force = true;
      };
    })

    (lib.mkIf cfg.groups.herdr {
      xdg.configFile."herdr/config.toml" = file "dotfiles/herdr/config.toml";
    })

    (lib.mkIf agentSkillsEnabled {
      home.file.".agents/.skill-lock.json" = file "dotfiles/agents/.skill-lock.json";
      home.file.".agents/skills" = dir agentSkillsPath;
      xdg.configFile."agents/skills" = dir agentSkillsPath;
    })

    (lib.mkIf codex {
      home.file.".codex/AGENTS.md" = file "dotfiles/codex/AGENTS.md";
      home.file.".codex/hooks.json" = file "dotfiles/codex/hooks.json";
      home.file.".codex/herdr-agent-state.sh" = file "dotfiles/codex/herdr-agent-state.sh";
      home.file.".codex/rules/default.rules" = file "dotfiles/codex/rules/default.rules";
      home.file.".codex/skills" = lib.mkIf agentSkillsEnabled (dir agentSkillsPath);
    })

    (lib.mkIf claude {
      home.file.".claude/settings.json" = file "dotfiles/claude/settings.json";
      home.file.".claude/hooks/herdr-agent-state.sh" = file "dotfiles/claude/hooks/herdr-agent-state.sh";
      home.file.".claude/skills" = lib.mkIf agentSkillsEnabled (dir agentSkillsPath);
    })

    (lib.mkIf opencode {
      xdg.configFile."opencode/opencode.json" = file "dotfiles/opencode/opencode.json";
      xdg.configFile."opencode/package.json" = file "dotfiles/opencode/package.json";
      xdg.configFile."opencode/plugins" = dir "dotfiles/opencode/plugins";
      xdg.configFile."opencode/skills" = lib.mkIf agentSkillsEnabled (dir agentSkillsPath);
    })

    (lib.mkIf pi {
      home.file.".pi/agent/keybindings.json" = file "dotfiles/pi/agent/keybindings.json";
      home.file.".pi/agent/settings.json" = file cfg.piSettingsFile;
      home.file.".pi/agent/models.json" = file "dotfiles/pi/agent/models.json";
      home.file.".pi/agent/mcp.json" = file "dotfiles/pi/agent/mcp.json";
      home.file.".pi/agent/extensions" = dir "dotfiles/pi/agent/extensions";
      home.file.".pi/agent/bin" = dir "dotfiles/pi/agent/bin";
      home.file.".pi/agent/npm" = dir "dotfiles/pi/agent/npm";
      home.file.".pi/agent/prompts" = dir "dotfiles/pi/agent/prompts";
      home.file.".pi/agent/themes" = dir "dotfiles/pi/agent/themes";
    })

    (lib.mkIf (pi && agentSkillsEnabled) {
      home.file.".pi/agent/skills" = dir agentSkillsPath;
    })

    (lib.mkIf (pi && !agentSkillsEnabled) {
      home.file.".pi/agent/skills" = dir "dotfiles/pi/agent/skills";
    })

    (lib.mkIf cfg.groups.macos {
      home.file.".hammerspoon/init.lua" = file "dotfiles/hammerspoon/init.lua";
      xdg.configFile."aerospace/aerospace.toml" = file "dotfiles/aerospace/aerospace.toml";
      xdg.configFile."karabiner/karabiner.json" = file "dotfiles/karabiner/karabiner.json";
      xdg.configFile."graphite/aliases" = file "dotfiles/graphite/aliases";
      xdg.configFile."sketchybar" = dir "dotfiles/sketchybar";
      xdg.configFile."wezterm/wezterm.lua" = file "dotfiles/wezterm/wezterm.lua";
      xdg.configFile."amp" = dir "dotfiles/amp";
      xdg.configFile."cmux/cmux.json" = file "dotfiles/cmux/cmux.json";
    })
  ]);
}
