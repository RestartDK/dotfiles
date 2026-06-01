{ config, pkgs, lib, ... }:

{
  home.username = "dkumlin";
  home.homeDirectory = "/home/dkumlin";
  home.stateVersion = "26.05";

  programs.home-manager.enable = true;
  xdg.enable = true;

  home.packages = with pkgs; [
    eza
    fd
    ripgrep
    fzf
    bat
    jq
    yq
    btop
    fnm
    bun
    go
    rustup
    python3
    uv
    poetry
    lazygit

    # Coding agents. These are user-facing CLIs, so they live in Home Manager.
    codex
    claude-code
    pi-coding-agent
    opencode
  ];

  programs.git = {
    enable = true;
    ignores = [ "**/.claude/settings.local.json" ];
    settings = {
      user = {
        name = "Daniel Kumlin";
        email = "danielkumlinwork@gmail.com";
      };
    };
  };

  programs.zsh = {
    enable = true;
    enableCompletion = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;
    plugins = [
      {
        name = "zsh-vi-mode";
        src = pkgs.zsh-vi-mode;
        file = "share/zsh-vi-mode/zsh-vi-mode.plugin.zsh";
      }
    ];
    shellAliases = {
      ls = "eza --icons=always";
    };
    history = {
      path = "$HOME/.zhistory";
      save = 1000;
      size = 999;
      share = true;
      ignoreDups = true;
    };
    initContent = ''
      # Portable shell setup for macOS/Linux. Keep secrets out of this file.
      path_prepend() {
        [[ -d "$1" ]] || return 0
        case ":$PATH:" in
          *":$1:"*) ;;
          *) export PATH="$1:$PATH" ;;
        esac
      }

      path_append() {
        [[ -d "$1" ]] || return 0
        case ":$PATH:" in
          *":$1:"*) ;;
          *) export PATH="$PATH:$1" ;;
        esac
      }

      path_append "$HOME/.lmstudio/bin"
      path_append "$HOME/.local/bin"
      path_prepend "$HOME/.rbenv/bin"
      path_prepend "$HOME/.bun/bin"
      path_prepend "$HOME/railpack/bin"
      path_append "$HOME/.pub-cache/bin"
      path_append "$HOME/.kluster/cli/bin"

      export GOPATH="$HOME/go"
      path_prepend "$GOPATH/bin"

      export FNM_VERSION_FILE_STRATEGY="local"
      export FNM_DIR="$HOME/.local/share/fnm"
      export FNM_LOGLEVEL="info"
      export FNM_NODE_DIST_MIRROR="https://nodejs.org/dist"
      export FNM_COREPACK_ENABLED="false"
      export FNM_RESOLVE_ENGINES="true"
      case "$(uname -m)" in
        arm64|aarch64) export FNM_ARCH="arm64" ;;
        x86_64|amd64) export FNM_ARCH="x64" ;;
      esac

      if command -v cursor >/dev/null 2>&1; then
        export EDITOR="cursor -w"
        export VISUAL="cursor -w"
      elif command -v nvim >/dev/null 2>&1; then
        export EDITOR="nvim"
        export VISUAL="nvim"
      fi

      command -v fnm >/dev/null 2>&1 && eval "$(fnm env --use-on-cd --shell zsh)"
      command -v rbenv >/dev/null 2>&1 && eval "$(rbenv init -)"

      if [[ -d "$HOME/Library/pnpm" ]]; then
        export PNPM_HOME="$HOME/Library/pnpm"
        path_prepend "$PNPM_HOME"
      elif [[ -d "$HOME/.local/share/pnpm" ]]; then
        export PNPM_HOME="$HOME/.local/share/pnpm"
        path_prepend "$PNPM_HOME"
      fi

      [[ -s "$HOME/.bun/_bun" ]] && source "$HOME/.bun/_bun"
      [[ -d "$HOME/.local/share/zsh/site-functions" ]] && fpath=("$HOME/.local/share/zsh/site-functions" $fpath)

      # Lets the /revive Pi extension switch profiles in the same terminal.
      __pi_revive_run() {
        local cmd="$1"
        shift
        local revive_file="$HOME/.pi/agent/revive.zsh"

        while true; do
          case "$cmd" in
            pi)
              command env -u PI_CODING_AGENT_DIR pi "$@"
              ;;
            *)
              command "$cmd" "$@"
              ;;
          esac

          if [[ ! -f "$revive_file" ]]; then
            return
          fi

          local PI_REVIVE_COMMAND=""
          local PI_REVIVE_AGENT_DIR=""
          local PI_REVIVE_SESSION=""
          local PI_REVIVE_CWD=""
          source "$revive_file"
          rm -f "$revive_file"

          if [[ -z "$PI_REVIVE_COMMAND" || -z "$PI_REVIVE_SESSION" ]]; then
            echo "Invalid Pi revive request: $revive_file" >&2
            return 1
          fi

          if [[ -n "$PI_REVIVE_CWD" ]]; then
            cd "$PI_REVIVE_CWD" || return
          fi

          cmd="$PI_REVIVE_COMMAND"
          case "$PI_REVIVE_AGENT_DIR" in
            "$HOME/.pi/agent"|"")
              export PI_CODING_AGENT_DIR=""
              unset PI_CODING_AGENT_DIR
              ;;
            *)
              export PI_CODING_AGENT_DIR="$PI_REVIVE_AGENT_DIR"
              ;;
          esac
          set -- --session "$PI_REVIVE_SESSION"
        done
      }

      pi() { __pi_revive_run pi "$@"; }
    '';
  };

  programs.starship = {
    enable = true;
    enableZshIntegration = true;
    settings = builtins.fromTOML (builtins.readFile ./files/starship.toml);
  };

  programs.fzf = {
    enable = true;
    enableZshIntegration = true;
  };

  programs.neovim = {
    enable = true;
    defaultEditor = true;
    viAlias = true;
    vimAlias = true;
    extraPackages = with pkgs; [
      gcc
      gnumake
      nodejs
      python3
      ripgrep
      fd
      tree-sitter
      unzip
      stylua
    ];
  };

  home.file.".tmux.conf".source = ./files/tmux-root.conf;
  xdg.configFile."tmux" = {
    source = ./files/tmux;
    recursive = true;
  };

  xdg.configFile."nvim" = {
    source = ./files/nvim;
    recursive = true;
  };

  xdg.configFile."opencode/opencode.json".source = ./files/opencode/opencode.json;
  xdg.configFile."opencode/package.json".source = ./files/opencode/package.json;
  xdg.configFile."opencode/plugins" = {
    source = ./files/opencode/plugins;
    recursive = true;
  };
  xdg.configFile."opencode/skills" = {
    source = ./files/agents/skills;
    recursive = true;
  };

  xdg.configFile."herdr/config.toml".source = ./files/herdr/config.toml;
  xdg.configFile."git/ignore".source = ./files/git/ignore;
  xdg.configFile."btop/btop.conf".source = ./files/btop/btop.conf;
  home.file.".agents" = {
    source = ./files/agents;
    recursive = true;
  };
  xdg.configFile."agents" = {
    source = ./files/agents;
    recursive = true;
  };

  home.file.".codex/skills" = {
    source = ./files/agents/skills;
    recursive = true;
  };
  home.file.".claude/skills" = {
    source = ./files/agents/skills;
    recursive = true;
  };

  home.file.".pi/agent/keybindings.json".source = ./files/pi/agent/keybindings.json;
  home.file.".pi/agent/settings.json".source = ./files/pi/agent/settings.json;
  home.file.".pi/agent/models.json".source = ./files/pi/agent/models.json;
  home.file.".pi/agent/extensions" = {
    source = ./files/pi/agent/extensions;
    recursive = true;
  };
  home.file.".pi/agent/npm" = {
    source = ./files/pi/agent/npm;
    recursive = true;
  };
  home.file.".pi/agent/prompts" = {
    source = ./files/pi/agent/prompts;
    recursive = true;
  };
  home.file.".pi/agent/themes" = {
    source = ./files/pi/agent/themes;
    recursive = true;
  };
  home.file.".pi/agent/skills" = {
    source = ./files/agents/skills;
    recursive = true;
  };


  home.file.".codex/AGENTS.md".source = ./files/codex/AGENTS.md;
  home.file.".codex/hooks.json".source = ./files/codex/hooks.json;
  home.file.".codex/herdr-agent-state.sh" = {
    source = ./files/codex/herdr-agent-state.sh;
    executable = true;
  };
  home.file.".codex/rules/default.rules".source = ./files/codex/rules/default.rules;

  home.file.".claude/settings.json".source = ./files/claude/settings.json;
  home.file.".claude/hooks/herdr-agent-state.sh" = {
    source = ./files/claude/hooks/herdr-agent-state.sh;
    executable = true;
  };
}
