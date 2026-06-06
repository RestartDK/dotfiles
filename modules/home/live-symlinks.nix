{ config, lib, ... }:

let
  cfg = config.my.liveConfig;
  link = path: config.lib.file.mkOutOfStoreSymlink "${cfg.repoRoot}/${path}";
in
{
  options.my.liveConfig = {
    enable = lib.mkEnableOption "live out-of-store dotfile symlinks";

    repoRoot = lib.mkOption {
      type = lib.types.str;
      description = "Absolute path to the editable nix-config checkout on this host.";
    };

    codexConfigPath = lib.mkOption {
      type = lib.types.str;
      default = "dotfiles/codex/common/.codex/config.toml";
      description = "Repo-relative path to the host-appropriate Codex config.toml.";
    };

    groups = {
      shell = lib.mkEnableOption "shell/starship config";
      git = lib.mkEnableOption "Git config";
      editors = lib.mkEnableOption "editor config";
      terminalTools = lib.mkEnableOption "terminal utility config";
      herdr = lib.mkEnableOption "Herdr config";
      agents = lib.mkEnableOption "AI agent config";
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    (lib.mkIf cfg.groups.shell {
      home.file.".zshrc".source = link "dotfiles/shell/.zshrc";
      xdg.configFile."starship.toml".source = link "dotfiles/shell/.config/starship.toml";
    })

    (lib.mkIf cfg.groups.git {
      xdg.configFile."git/ignore".source = link "dotfiles/git/.config/git/ignore";
    })

    (lib.mkIf cfg.groups.editors {
      xdg.configFile."nvim" = {
        source = link "dotfiles/nvim/.config/nvim";
        recursive = false;
      };
    })

    (lib.mkIf cfg.groups.terminalTools {
      xdg.configFile."btop/btop.conf".source = link "dotfiles/btop/.config/btop/btop.conf";
      xdg.configFile."thefuck/settings.py".source = link "dotfiles/thefuck/.config/thefuck/settings.py";
    })

    (lib.mkIf cfg.groups.herdr {
      xdg.configFile."herdr/config.toml".source = link "dotfiles/herdr/.config/herdr/config.toml";
    })

    (lib.mkIf cfg.groups.agents {
      home.file.".agents/.skill-lock.json".source = link "dotfiles/agents/.agents/.skill-lock.json";
      home.file.".agents/skills" = {
        source = link "dotfiles/agents/.agents/skills";
        recursive = false;
      };
      xdg.configFile."agents/skills" = {
        source = link "dotfiles/agents/.agents/skills";
        recursive = false;
      };

      home.file.".codex/AGENTS.md".source = link "dotfiles/codex/.codex/AGENTS.md";
      home.file.".codex/config.toml".source = link cfg.codexConfigPath;
      home.file.".codex/hooks.json".source = link "dotfiles/codex/.codex/hooks.json";
      home.file.".codex/herdr-agent-state.sh".source = link "dotfiles/codex/.codex/herdr-agent-state.sh";
      home.file.".codex/rules/default.rules".source = link "dotfiles/codex/.codex/rules/default.rules";
      home.file.".codex/skills" = {
        source = link "dotfiles/agents/.agents/skills";
        recursive = false;
      };

      home.file.".claude/settings.json".source = link "dotfiles/claude/.claude/settings.json";
      home.file.".claude/hooks/herdr-agent-state.sh".source = link "dotfiles/claude/.claude/hooks/herdr-agent-state.sh";
      home.file.".claude/skills" = {
        source = link "dotfiles/agents/.agents/skills";
        recursive = false;
      };

      xdg.configFile."opencode/opencode.json".source = link "dotfiles/opencode/.config/opencode/opencode.json";
      xdg.configFile."opencode/package.json".source = link "dotfiles/opencode/.config/opencode/package.json";
      xdg.configFile."opencode/plugins" = {
        source = link "dotfiles/opencode/.config/opencode/plugins";
        recursive = false;
      };
      xdg.configFile."opencode/skills" = {
        source = link "dotfiles/agents/.agents/skills";
        recursive = false;
      };

      home.file.".pi/agent/keybindings.json".source = link "dotfiles/pi/.pi/agent/keybindings.json";
      home.file.".pi/agent/settings.json".source = link "dotfiles/pi/.pi/agent/settings.json";
      home.file.".pi/agent/models.json".source = link "dotfiles/pi/.pi/agent/models.json";
      home.file.".pi/agent/extensions" = {
        source = link "dotfiles/pi/.pi/agent/extensions";
        recursive = false;
      };
      home.file.".pi/agent/npm" = {
        source = link "dotfiles/pi/.pi/agent/npm";
        recursive = false;
      };
      home.file.".pi/agent/prompts" = {
        source = link "dotfiles/pi/.pi/agent/prompts";
        recursive = false;
      };
      home.file.".pi/agent/themes" = {
        source = link "dotfiles/pi/.pi/agent/themes";
        recursive = false;
      };
      home.file.".pi/agent/skills" = {
        source = link "dotfiles/agents/.agents/skills";
        recursive = false;
      };
    })
  ]);
}
