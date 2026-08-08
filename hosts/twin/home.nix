_:

let
  settings = import ./settings.nix;
in
{
  imports = [
    ../../modules/home/live-symlinks.nix
    ../../modules/home/twin-dev-environment.nix
  ];

  home = {
    file.".zshenv".text = ''
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

    username = settings.userName;
    inherit (settings) homeDirectory;
    stateVersion = settings.homeStateVersion;
  };

  my.twinDevEnvironment.enable = true;

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
      multiplexer = true;
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
