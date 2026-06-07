{ config, lib, ... }:

let
  cfg = config.my.liveConfig;
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

    groups = {
      shell = lib.mkEnableOption "shell/starship config";
      git = lib.mkEnableOption "Git config";
      editors = lib.mkEnableOption "editor config";
      terminalTools = lib.mkEnableOption "terminal utility config";
      ghostty = lib.mkEnableOption "Ghostty terminal config";
      wayland = lib.mkEnableOption "Wayland desktop config";
      herdr = lib.mkEnableOption "Herdr config";
      agents = lib.mkEnableOption "AI agent config";
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
      xdg.configFile."thefuck/settings.py" = file "dotfiles/thefuck/settings.py";
    })

    (lib.mkIf cfg.groups.ghostty {
      xdg.configFile."ghostty" = dir "dotfiles/ghostty";
    })

    (lib.mkIf cfg.groups.wayland {
      xdg.configFile."hypr" = dir "dotfiles/hypr";
      xdg.configFile."waybar" = dir "dotfiles/waybar";
    })

    (lib.mkIf cfg.groups.herdr {
      xdg.configFile."herdr/config.toml" = file "dotfiles/herdr/config.toml";
    })

    (lib.mkIf cfg.groups.agents {
      home.file.".agents/.skill-lock.json" = file "dotfiles/agents/.skill-lock.json";
      home.file.".agents/skills" = dir "dotfiles/agents/skills";
      xdg.configFile."agents/skills" = dir "dotfiles/agents/skills";

      home.file.".codex/AGENTS.md" = file "dotfiles/codex/AGENTS.md";
      home.file.".codex/hooks.json" = file "dotfiles/codex/hooks.json";
      home.file.".codex/herdr-agent-state.sh" = file "dotfiles/codex/herdr-agent-state.sh";
      home.file.".codex/rules/default.rules" = file "dotfiles/codex/rules/default.rules";
      home.file.".codex/skills" = dir "dotfiles/agents/skills";

      home.file.".claude/settings.json" = file "dotfiles/claude/settings.json";
      home.file.".claude/hooks/herdr-agent-state.sh" = file "dotfiles/claude/hooks/herdr-agent-state.sh";
      home.file.".claude/skills" = dir "dotfiles/agents/skills";

      xdg.configFile."opencode/opencode.json" = file "dotfiles/opencode/opencode.json";
      xdg.configFile."opencode/package.json" = file "dotfiles/opencode/package.json";
      xdg.configFile."opencode/plugins" = dir "dotfiles/opencode/plugins";
      xdg.configFile."opencode/skills" = dir "dotfiles/agents/skills";

      home.file.".pi/agent/keybindings.json" = file "dotfiles/pi/agent/keybindings.json";
      home.file.".pi/agent/settings.json" = file "dotfiles/pi/agent/settings.json";
      home.file.".pi/agent/models.json" = file "dotfiles/pi/agent/models.json";
      home.file.".pi/agent/extensions" = dir "dotfiles/pi/agent/extensions";
      home.file.".pi/agent/npm" = dir "dotfiles/pi/agent/npm";
      home.file.".pi/agent/prompts" = dir "dotfiles/pi/agent/prompts";
      home.file.".pi/agent/themes" = dir "dotfiles/pi/agent/themes";
      home.file.".pi/agent/skills" = dir "dotfiles/agents/skills";
    })

    (lib.mkIf cfg.groups.macos {
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
