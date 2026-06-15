{ pkgs, inputs, agentPackageNames ? [ "codex" "claude-code" "opencode" "pi-coding-agent" ] }:

let
  herdr = pkgs.callPackage ../../packages/herdr.nix { };
  unstable = import inputs.nixpkgs-unstable {
    system = pkgs.stdenv.hostPlatform.system;
    config = pkgs.config;
  };
  availableAgentPackages = {
    codex = unstable.codex;
    "claude-code" = unstable.claude-code;
    opencode = unstable.opencode;
    "pi-coding-agent" = unstable.pi-coding-agent;
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

  neovim
  gcc
  gnumake
  nodejs
  tree-sitter
  unzip
  stylua

  # Installed so the live .zshrc can source them without Home Manager
  # generating an immutable ~/.zshrc.
  zsh-autosuggestions
  zsh-syntax-highlighting
  zsh-vi-mode
] ++ agentPackages
