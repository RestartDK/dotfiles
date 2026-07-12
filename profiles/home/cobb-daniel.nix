{ config, lib, osConfig ? null, pkgs, ... }:

let
  hostName = if osConfig == null then "" else osConfig.networking.hostName or "";
  isCobbDevHost = builtins.elem hostName [
    "monster"
    "titan"
    "titan-2"
  ];
  osDevNetnsConfig = if osConfig == null then { } else ((osConfig.twin or { }).devNetns or { });
  configuredRunDevNetnsCommand = osDevNetnsConfig.runDevNetnsCommand or null;
  runDevNetnsCommand =
    if configuredRunDevNetnsCommand == null then
      "/run/current-system/sw/bin/run-dev-netns"
    else
      configuredRunDevNetnsCommand;
in
{
  imports = [
    ../../modules/home/live-symlinks.nix
    ../../modules/home/twin-dev-environment.nix
  ];

  # Cobb owns the machine, users, namespace pool, services, and company-wide
  # defaults. Daniel's full personal development environment is enabled only on
  # Cobb development hosts; support and production retain Cobb's defaults.
  my.twinDevEnvironment.enable = isCobbDevHost;

  my.liveConfig = {
    enable = isCobbDevHost;
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

      # Cobb continues to own OpenCode, Codex, Claude, and shared agent skills.
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

  # Preserve Cobb's Cursor/VS Code behavior while allowing the portable live
  # .zshrc to remain the sole owner of Daniel's interactive shell configuration.
  xdg.configFile."shell/cobb-vscode-netns.zsh" = lib.mkIf isCobbDevHost {
    text = ''
      if [[ -n "''${VSCODE_IPC_HOOK_CLI:-}" ]] && [[ -e /var/run/netns/dev-$USER ]]; then
        current_ns="$(${pkgs.coreutils}/bin/stat -Lc '%d:%i' /proc/self/ns/net)"
        target_ns="$(${pkgs.coreutils}/bin/stat -Lc '%d:%i' /var/run/netns/dev-$USER)"
        if [[ "$current_ns" != "$target_ns" ]]; then
          exec /run/wrappers/bin/sudo -n -E ${runDevNetnsCommand} dev-$USER \
            ${pkgs.zsh}/bin/zsh -l
        fi
      fi
    '';
  };

  programs.git.settings.user = lib.mkDefault {
    name = "Daniel Kumlin";
    email = "danielkumlinwork@gmail.com";
  };
}
