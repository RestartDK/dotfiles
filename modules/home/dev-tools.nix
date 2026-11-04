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
    agents.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install the agent CLIs: agent-browser, codex, claude-code, opencode, and pi.";
    };
    checkoutTools.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install tools that operate on a dotfiles checkout, such as traitor.";
    };
  };

  # Host-specific packages go in the host's own `home.packages`, which merges
  # with this list.
  config.home.packages =
    with pkgs;
    [
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
      bun
      go
      rustc
      cargo
      rust-analyzer
      rustfmt
      clippy
      tlaplus
      pkg-config
      openssl
      python3
      uv
      poetry
      lazygit
      gh
      (yazi.override {
        _7zz = _7zz-rar;
      })
      file
      ffmpeg
      _7zz-rar
      poppler-utils
      zoxide
      resvg
      imagemagick

      neovim
      nixd
      nixfmt
      deadnix
      statix
      actionlint
      shellcheck
      shfmt
      oxlint
      oxfmt
      taplo
      gnumake
      nodejs
      pnpm
      tree-sitter
      unzip
      stylua

      self.fleet
      self.agent-desktop
    ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [
      gcc
    ]
    ++ lib.optionals cfg.agents.enable [
      llmAgents.agent-browser
      llmAgents.codex
      llmAgents.claude-code
      opencode
      self.pi
    ]
    ++ lib.optionals cfg.checkoutTools.enable [
      self.traitor
    ];
}
