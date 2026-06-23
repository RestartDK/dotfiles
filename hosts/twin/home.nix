{ pkgs, inputs, ... }:

let
  settings = import ./settings.nix;
in
{
  imports = [
    ../../modules/home/live-symlinks.nix
    ../../modules/home/pi-opencode-netns-wrapper.nix
  ];

  programs.home-manager.enable = true;
  xdg.enable = true;

  # Dev packages only. Unlike modules/home/dev-packages.nix, this intentionally
  # does not manage programs.git.settings so it does not overwrite the target
  # machine's existing Git aliases, LFS setup, or signing config.
  home.packages = import ../../modules/home/dev-package-list.nix {
    inherit pkgs inputs;
    agentPackageNames = [ "pi-coding-agent" ];
  };

  home.username = settings.userName;
  home.homeDirectory = settings.homeDirectory;
  home.stateVersion = settings.homeStateVersion;
  # The twin dev profile follows nixpkgs-unstable, while the shared Home Manager
  # input remains release-26.05 for the rest of the repo.
  home.enableNixpkgsReleaseCheck = false;

  my.liveConfig = {
    enable = true;
    repoRoot = "${settings.homeDirectory}/Projects/nix-config";
    piSettingsFile = "dotfiles/pi/agent/settings-twin.json";
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
