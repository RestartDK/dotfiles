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
    username = settings.userName;
    inherit (settings) homeDirectory;
    stateVersion = settings.homeStateVersion;
  };

  my.twinDevEnvironment.enable = true;

  my.ai.profile = "work";

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
      agents = false;
      agentSkills = false;
      pi = true;
      codex = false;
      claude = false;
      opencode = false;

      wayland = false;
      macos = false;
    };
  };
}
