{
  config,
  dotfilesInputs,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.twinDevEnvironment;
in
{
  imports = [
    ./cobb-vscode-netns.nix
    ./pi-opencode-netns-wrapper.nix
  ];

  options.my.twinDevEnvironment.enable = lib.mkEnableOption "Daniel's reusable Twin development environment";

  config = lib.mkIf cfg.enable {
    services.lorri.enable = true;
    xdg.enable = true;

    # Home Manager writes `.zshenv` itself for its session variables, and newer
    # versions target the equivalent path `./.zshenv`, so a second
    # `home.file.".zshenv"` collides and fails the generation build. `envExtra`
    # merges into the file Home Manager already writes, runs for every non-login
    # shell (including the `zsh -c` shells herdr's remote bridge spawns), and
    # sources the shared snippet so interactive shells, dev hosts, and this
    # file all run one implementation.
    programs.zsh.envExtra = ''
      [[ -r "$HOME/.config/dotfiles/config/shell/agent-refresh.zsh" ]] &&
        source "$HOME/.config/dotfiles/config/shell/agent-refresh.zsh"
    '';

    # Keep Git identity, aliases, signing, and other host policy in the owning
    # profile while sharing Daniel's development tools across Twin and Cobb.
    home.packages = import ./dev-package-list.nix {
      inherit pkgs;
      inputs = dotfilesInputs;
      agentPackageNames = [ ];
    };

    home.enableNixpkgsReleaseCheck = false;
    my.piNetnsWrapper.enable = true;
  };
}
