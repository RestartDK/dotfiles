{ pkgs, inputs, ... }:

let
  settings = import ./settings.nix;
in
{
  imports = [
    inputs.hunk.homeManagerModules.default
    ../../modules/home/live-symlinks.nix
    ../../modules/home/pi-opencode-netns-wrapper.nix
  ];

  programs.home-manager.enable = true;
  programs.hunk.enable = true;
  services.lorri.enable = true;
  xdg.enable = true;

  home.file.".zshenv".text = ''
    agent_dir="$HOME/.ssh/agent"
    agent_link="$agent_dir/current"

    if [ -n "''${SSH_AUTH_SOCK:-}" ] &&
       [ "$SSH_AUTH_SOCK" != "$agent_link" ] &&
       [ -S "$SSH_AUTH_SOCK" ]; then
      mkdir -p "$agent_dir"
      ln -sfnT "$SSH_AUTH_SOCK" "$agent_link"
    fi

    if [ ! -S "$agent_link" ]; then
      newest_agent_socket="$(find "$agent_dir" -maxdepth 1 -type s -name 's.*' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)"
      if [ -n "$newest_agent_socket" ]; then
        mkdir -p "$agent_dir"
        ln -sfnT "$newest_agent_socket" "$agent_link"
      fi
    fi

    if [ -S "$agent_link" ]; then
      export SSH_AUTH_SOCK="$agent_link"
    fi
  '';

  # Dev packages only. Unlike modules/home/dev-packages.nix, this intentionally
  # does not manage programs.git.settings so it does not overwrite the target
  # machine's existing Git aliases, LFS setup, or signing config.
  home.packages = import ../../modules/home/dev-package-list.nix {
    inherit pkgs inputs;
    agentPackageNames = [ ];
  };

  home.username = settings.userName;
  home.homeDirectory = settings.homeDirectory;
  home.stateVersion = settings.homeStateVersion;
  # The twin dev profile follows nixpkgs-unstable, while the shared Home Manager
  # input remains release-26.05 for the rest of the repo.
  home.enableNixpkgsReleaseCheck = false;

  my.liveConfig = {
    enable = true;
    repoRoot = "${settings.homeDirectory}/.config/dotfiles";
    piSettingsFile = "config/pi/agent/settings-twin.json";
    piSkillsPath = "config/pi/agent/skills-twin";
    groups = {
      shell = true;
      git = true;
      editors = true;
      terminalTools = true;
      ghostty = true;
      herdr = true;
      # Keep the remote profile from touching existing Codex, Claude, OpenCode,
      # or shared agent skills. Only Pi itself and Pi-specific config are managed.
      agents = false;
      agentSkills = false;
      agentSkillsGlobal = false;
      agentSkillsPersonal = false;
      pi = true;
      codex = false;
      claude = false;
      opencode = false;

      wayland = false;
      macos = false;
    };
  };
}
