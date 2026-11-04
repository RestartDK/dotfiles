{
  ...
}:

{
  imports = [
    ../../modules/home/groups.nix
    ../../modules/home/cobb-vscode-netns.nix
    ../../modules/home/pi-opencode-netns-wrapper.nix
    ../../modules/home/dev-tools.nix
  ];

  # The consumer owns identity, the AI profile, and the host gate. This module
  # contributes the development packages and the live-config groups only.
  my.piNetnsWrapper.enable = true;

  services.lorri.enable = true;
  xdg.enable = true;

  # Home Manager writes `.zshenv` itself for its session variables, and newer
  # versions target the equivalent path `./.zshenv`, so a second
  # `home.file.".zshenv"` collides and fails the generation build. `envExtra`
  # merges into the file Home Manager already writes, runs for every non-login
  # shell (including the `zsh -c` shells herdr's remote bridge spawns), and
  # sources the shared snippet so interactive shells and dev hosts run one
  # implementation.
  programs.zsh.envExtra = ''
    source "${../../config/shell/agent-refresh.zsh}"
  '';

  # The consumer installs its own agent CLIs, and there is no dotfiles checkout
  # here for the checkout tools to operate on.
  my.devTools = {
    agents.enable = false;
    checkoutTools.enable = false;
  };

  home.enableNixpkgsReleaseCheck = false;

  my.liveConfig = {
    enable = true;
    piSkillsPath = "config/agents/skills";
    groups = {
      shell = true;
      git = true;
      editors = true;
      terminalTools = true;
      ghostty = true;
      multiplexer = true;
      pi = true;
      # The consumer installs Claude Code but links no skills for it.
      claudeSkills = true;

      # The consumer owns Codex, Claude, opencode, and the shared agent trees.
      agents = false;
      agentSkills = false;
      codex = false;
      claude = false;
      opencode = false;
    };
  };
}
