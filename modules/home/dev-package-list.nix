{ pkgs, inputs, agentPackageNames ? [ "codex" "claude-code" "opencode" "pi-coding-agent" ] }:

let
  herdr = pkgs.callPackage ../../packages/herdr.nix { };
  herdrWorktreeCreate = pkgs.writeShellApplication {
    name = "herdr-worktree-create";
    runtimeInputs = [ pkgs.python3 pkgs.git herdr ];
    text = ''
      exec ${pkgs.python3}/bin/python3 ${../../dotfiles/pi/agent/bin/herdr-worktree-create} "$@"
    '';
  };
  unstable = import inputs.nixpkgs-unstable {
    system = pkgs.stdenv.hostPlatform.system;
    config = pkgs.config;
  };
  piCodingAgent = unstable.callPackage ../../packages/pi-coding-agent.nix {
    src = inputs.pi-src;
  };
  availableAgentPackages = {
    codex = unstable.codex;
    "claude-code" = unstable.claude-code;
    opencode = unstable.opencode;
    "pi-coding-agent" = piCodingAgent;
  };
  agentPackages = map (
    name:
    if builtins.hasAttr name availableAgentPackages then
      builtins.getAttr name availableAgentPackages
    else
      throw "unknown agent package: ${name}"
  ) agentPackageNames;
in
with pkgs; [
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
  fnm
  bun
  go
  rustup
  pkg-config
  openssl
  python3
  uv
  poetry
  lazygit
  gh
  herdr
  herdrWorktreeCreate

  neovim
  gcc
  gnumake
  nodejs
  pnpm
  tree-sitter
  unzip
  stylua

  # Installed so the live .zshrc can source them without Home Manager
  # generating an immutable ~/.zshrc.
  zsh-autosuggestions
  zsh-syntax-highlighting
  zsh-vi-mode
] ++ agentPackages
