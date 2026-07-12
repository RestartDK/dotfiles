{ config, lib, osConfig ? null, ... }:

let
  hostName = if osConfig == null then "" else osConfig.networking.hostName or "";
  isCobbDevHost = builtins.elem hostName [
    "monster"
    "titan"
    "titan-2"
  ];
in
{
  imports = [ ../../modules/home/live-symlinks.nix ];

  # Cobb owns the machine, users, network namespaces, services, and most common
  # tool defaults. This bridge only points Daniel's user-level high-churn config
  # at the canonical RestartDK/dotfiles checkout on Cobb dev hosts.
  my.liveConfig = {
    enable = isCobbDevHost;
    repoRoot = "${config.home.homeDirectory}/.config/dotfiles";
    piSettingsFile = "config/pi/agent/settings-twin.json";
    piSkillsPath = "config/pi/agent/skills-twin";
    groups = {
      # Avoid .zshrc and OpenCode conflicts with Cobb's profiles/common.nix.
      shell = false;
      opencode = false;
      codex = false;
      claude = false;
      agents = false;
      agentSkills = false;
      agentSkillsGlobal = false;
      agentSkillsPersonal = false;

      git = true;
      editors = true;
      terminalTools = true;
      ghostty = true;
      herdr = true;
      pi = true;

      wayland = false;
      macos = false;
    };
  };

  programs.git.settings.user = lib.mkDefault {
    name = "Daniel Kumlin";
    email = "danielkumlinwork@gmail.com";
  };
}
