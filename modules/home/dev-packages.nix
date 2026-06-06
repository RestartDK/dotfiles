{ lib, pkgs, ... }:

let
  herdr = pkgs.callPackage ../../packages/herdr.nix { };
  linuxAgentPackages = lib.optionals pkgs.stdenv.isLinux [
    herdr
    pkgs.codex
    pkgs.claude-code
    pkgs.pi-coding-agent
    pkgs.opencode
  ];
in
{
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
  ] ++ linuxAgentPackages;

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
}
