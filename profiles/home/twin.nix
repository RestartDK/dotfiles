{ config, ... }:

{
  imports = [
    ../../modules/home/live-symlinks.nix
    ../../modules/home/twin-dev-environment.nix
  ];

  my.twinDevEnvironment.enable = true;

  my.liveConfig = {
    enable = true;
    repoRoot = "${config.home.homeDirectory}/.config/dotfiles";
    piSettingsFile = "config/pi/agent/settings-twin.json";
    piSkillsPath = "config/pi/agent/skills-twin";
    groups = {
      shell = true;
      git = true;
      editors = true;
      terminalTools = true;
      ghostty = true;
      multiplexer = true;

      # Remote twin profile: manage Pi-specific config, but do not touch existing
      # Codex, Claude, OpenCode, or shared agent skill installations.
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
