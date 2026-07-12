{ config, inputs ? { }, lib, pkgs, ... }:

{
  imports =
    [
      ../../modules/home/live-symlinks.nix
      ../../modules/home/pi-opencode-netns-wrapper.nix
    ]
    ++ lib.optional (inputs ? hunk) inputs.hunk.homeManagerModules.default;

  programs.home-manager.enable = true;
  programs.hunk.enable = lib.mkIf (inputs ? hunk) true;
  services.lorri.enable = true;
  xdg.enable = true;

  # Dev packages only. This intentionally does not manage programs.git.settings
  # so target machines keep their existing Git aliases, LFS setup, and signing config.
  home.packages = import ../../modules/home/dev-package-list.nix {
    inherit pkgs inputs;
    agentPackageNames = [ ];
  };

  home.enableNixpkgsReleaseCheck = false;

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
