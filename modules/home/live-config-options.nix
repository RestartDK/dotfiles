{ lib, ... }:

{
  options.my.liveConfig = {
    enable = lib.mkEnableOption "live out-of-store dotfile symlinks";

    repoRoot = lib.mkOption {
      type = lib.types.str;
      description = "Absolute path to the editable dotfiles checkout on this host.";
    };

    piSettingsFile = lib.mkOption {
      type = lib.types.str;
      default = "config/pi/agent/settings.json";
      description = "Repo-relative Pi settings JSON file to link as ~/.pi/agent/settings.json.";
    };

    piSkillsPath = lib.mkOption {
      type = lib.types.str;
      default = "config/pi/agent/skills";
      description = "Repo-relative Pi-specific skills directory to link as ~/.pi/agent/skills when shared agent skills are disabled.";
    };

    groups = {
      shell = lib.mkEnableOption "shell/starship config";
      git = lib.mkEnableOption "Git config";
      editors = lib.mkEnableOption "editor config";
      terminalTools = lib.mkEnableOption "terminal utility config";
      ghostty = lib.mkEnableOption "Ghostty terminal config";
      wayland = lib.mkEnableOption "Wayland desktop config";
      herdr = lib.mkEnableOption "Herdr config";
      agents = lib.mkEnableOption "all AI agent config";
      agentSkills = lib.mkEnableOption "all shared AI agent skills config";
      agentSkillsGlobal = lib.mkEnableOption "global AI agent skills config";
      agentSkillsPersonal = lib.mkEnableOption "personal AI agent skills config";
      codex = lib.mkEnableOption "Codex config";
      claude = lib.mkEnableOption "Claude config";
      opencode = lib.mkEnableOption "OpenCode config";
      pi = lib.mkEnableOption "Pi config";
      macos = lib.mkEnableOption "macOS-specific app config";
    };
  };
}
