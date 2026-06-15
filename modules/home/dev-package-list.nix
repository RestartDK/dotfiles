{ pkgs, inputs }:

let
  herdr = pkgs.callPackage ../../packages/herdr.nix { };
  unstable = import inputs.nixpkgs-unstable {
    system = pkgs.stdenv.hostPlatform.system;
    config = pkgs.config;
  };
  agentPackages = [
    unstable.codex
    unstable.claude-code
    unstable.opencode
    unstable.pi-coding-agent
  ];
in
with pkgs; [
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
