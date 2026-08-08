{
  pkgs,
  inputs,
  agentPackageNames ? [
    "agent-browser"
    "codex"
    "claude-code"
    "opencode"
    "pi-coding-agent"
  ],
}:

let
  llmAgents = inputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system};
  availableAgentPackages = {
    inherit (llmAgents) agent-browser codex opencode;
    "claude-code" = llmAgents.claude-code;
    "pi-coding-agent" = llmAgents.pi;
  };
  agentPackages = map (
    name:
    if builtins.hasAttr name availableAgentPackages then
      builtins.getAttr name availableAgentPackages
    else
      throw "unknown agent package: ${name}"
  ) agentPackageNames;
in
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

]
++ lib.optionals stdenv.hostPlatform.isLinux [
  gcc
]
++ agentPackages
