{
  config,
  lib,
  pkgs,
  dotfilesInputs,
  ...
}:

let
  cfg = config.my.devTools;
  self = dotfilesInputs.self.packages.${pkgs.stdenv.hostPlatform.system};
  llmAgents = dotfilesInputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system};
  # llm-agents installs OpenCode v2 as `opencode2` so it can coexist with v1.
  # Publish it under the v1 binary name, which every caller here already uses.
  opencode = pkgs.linkFarm "opencode-${llmAgents.opencode2.version}" [
    {
      name = "bin/opencode";
      path = "${llmAgents.opencode2}/bin/opencode2";
    }
  ];
in
{
  options.my.devTools = {
    cli = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = with pkgs; [
        eza
        fd
        ripgrep
        fzf
        direnv
        bat
        jq
        yq
        btop
        starship
        zoxide
        file
        unzip
        gnumake
        lazygit
        gh
        (yazi.override {
          _7zz = _7zz-rar;
        })
      ];
      description = "Shell and repository CLI tools.";
    };
    languages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = with pkgs; [
        bun
        go
        rustc
        cargo
        rust-analyzer
        rustfmt
        clippy
        pkg-config
        openssl
        python3
        uv
        poetry
        nodejs
        pnpm
        tlaplus
      ];
      description = "Language runtimes and compilers.";
    };
    editors = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = with pkgs; [
        neovim
        tree-sitter
        nixd
        nixfmt
        deadnix
        statix
        stylua
        taplo
        actionlint
        shellcheck
        shfmt
        oxlint
        oxfmt
      ];
      description = "Editor, formatting, and lint tooling.";
    };
    media = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = with pkgs; [
        ffmpeg
        _7zz-rar
        poppler-utils
        resvg
        imagemagick
      ];
      description = "Media and document tooling.";
    };
    agents = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [
        llmAgents.agent-browser
        llmAgents.codex
        llmAgents.claude-code
        opencode
        self.pi
      ];
      description = "Agent CLIs installed on this machine.";
    };
    repoTools = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [
        self.fleet
        self.agent-desktop
      ];
      description = "Repository commands installed on this machine.";
    };
    checkoutTools = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ self.traitor ];
      description = "Tools that operate on a dotfiles checkout.";
    };
    extra = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Host-specific packages.";
    };
  };

  config.home.packages =
    cfg.cli
    ++ cfg.languages
    ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.gcc ]
    ++ cfg.editors
    ++ cfg.media
    ++ cfg.agents
    ++ cfg.repoTools
    ++ cfg.checkoutTools
    ++ cfg.extra;
}
