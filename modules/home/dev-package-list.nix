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
  # llm-agents installs OpenCode v2 as `opencode2` so it can coexist with v1.
  # Publish it under the v1 binary name, which every caller here already uses.
  opencode = pkgs.linkFarm "opencode-${llmAgents.opencode2.version}" [
    {
      name = "bin/opencode";
      path = "${llmAgents.opencode2}/bin/opencode2";
    }
  ];
  availableAgentPackages = {
    inherit (llmAgents) agent-browser codex;
    inherit opencode;
    "claude-code" = llmAgents.claude-code;
    "pi-coding-agent" = inputs.self.packages.${pkgs.stdenv.hostPlatform.system}.pi;
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

  inputs.self.packages.${stdenv.hostPlatform.system}.fleet
  inputs.self.packages.${stdenv.hostPlatform.system}.agent-desktop
]
++ lib.optionals stdenv.hostPlatform.isLinux [
  gcc
]
++ agentPackages
