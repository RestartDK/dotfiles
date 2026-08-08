{
  config,
  lib,
  osConfig ? null,
  ...
}:

let
  hostName = if osConfig == null then "" else osConfig.networking.hostName or "";
  isCobbDevHost = builtins.elem hostName [
    "monster"
    "titan"
    "titan-2"
  ];
in
{
  imports = [
    ../../modules/home/live-symlinks.nix
    ../../modules/home/twin-dev-environment.nix
  ];

  # Cobb's NixOS Home Manager module is the sole activator. This imported
  # profile only contributes Daniel's development packages and high-churn
  # configuration.
  my.twinDevEnvironment.enable = isCobbDevHost;

  my.liveConfig = {
    enable = isCobbDevHost;
    repoRoot = "${config.home.homeDirectory}/.config/dotfiles";
    piSettingsFile = "config/pi/agent/settings-twin.json";
    piSkillsPath = "config/pi/agent/skills-twin";
    groups = {
      # Cobb's Daniel profile disables its generated shell and Neovim config
      # on development hosts, so the canonical dotfiles checkout owns both.
      shell = true;
      # Keep Cobb's work-agent defaults and credentials authoritative.
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
      multiplexer = true;
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
