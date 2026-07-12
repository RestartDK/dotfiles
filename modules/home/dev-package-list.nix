{ pkgs, inputs, agentPackageNames ? [ "codex" "claude-code" "opencode" "pi-coding-agent" ] }:

let
  herdr = pkgs.callPackage ../../packages/herdr.nix { };
  codexCli = pkgs.callPackage ../../packages/codex-cli.nix { };
  unstable = import inputs.nixpkgs-unstable {
    system = pkgs.stdenv.hostPlatform.system;
    config = pkgs.config;
  };
  piCodingAgent = unstable.callPackage ../../packages/pi-coding-agent.nix {
    src = inputs.pi-src;
  };
  availableAgentPackages = {
    # The nixpkgs Rust build currently pulls livekit-libwebrtc, which fails to
    # build on aarch64-darwin. Use OpenAI's npm binary distribution instead.
    codex = codexCli;
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
  lazygit
  gh
  herdr
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
] ++ lib.optionals stdenv.hostPlatform.isLinux [
  gcc
] ++ agentPackages
