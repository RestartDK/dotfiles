{ lib, ... }:

{
  options.my.ai.profile = lib.mkOption {
    type = lib.types.enum [
      "work"
      "personal"
    ];
    default = "personal";
    description = "Global billing policy for native Pi sessions and delegated workers.";
  };

  options.my.ai.openrouterKeyFile = lib.mkOption {
    type = lib.types.nullOr (lib.types.strMatching "/.+");
    default = null;
    description = "Runtime file that holds the OpenRouter key. Null links the repository model catalogue unchanged.";
  };

  options.my.ai.opencodeKeyFile = lib.mkOption {
    type = lib.types.nullOr (lib.types.strMatching "/.+");
    default = null;
    description = "Runtime file that holds the OpenCode Go key. Null leaves the opencode-go provider on its environment variable.";
  };

  options.my.liveConfig = {
    enable = lib.mkEnableOption "the host's dotfiles configuration layers";

    piSettingsFile = lib.mkOption {
      type = lib.types.str;
      default = "config/pi/agent/settings.json";
      description = "Repo-relative Pi settings JSON file to link as ~/.pi/agent/settings.json.";
    };

    piSkillsPath = lib.mkOption {
      type = lib.types.str;
      default = "config/pi/agent/skills";
      description = "Repo-relative Pi-specific skills directory to link as ~/.agents/skills when shared agent skills are disabled.";
    };

    groups = {
      shell = lib.mkEnableOption "shell/starship config";
      git = lib.mkEnableOption "Git config";
      editors = lib.mkEnableOption "editor config";
      terminalTools = lib.mkEnableOption "terminal utility config";
      ghostty = lib.mkEnableOption "Ghostty terminal config";
      wayland = lib.mkEnableOption "Wayland desktop config";
      multiplexer = lib.mkEnableOption "terminal multiplexer config (Herdr)";
      agents = lib.mkEnableOption "all AI agent config";
      agentSkills = lib.mkEnableOption "shared AI agent skills config";
      codex = lib.mkEnableOption "Codex config";
      claude = lib.mkEnableOption "Claude config";
      opencode = lib.mkEnableOption "OpenCode config";
      pi = lib.mkEnableOption "Pi config";
      macos = lib.mkEnableOption "macOS-specific app config";
    };
  };
}
