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

    home.file.".zshenv".text = ''
      agent_dir="$HOME/.ssh/agent"
      agent_link="$agent_dir/current"
      incoming_agent="''${SSH_AUTH_SOCK:-}"

      if [ -n "$incoming_agent" ] &&
         [ "$incoming_agent" != "$agent_link" ] &&
         [ -S "$incoming_agent" ] &&
         { [[ "''${ZSH_EXECUTION_STRING:-}" == *"herdr remote-client-bridge"* ]] || [ ! -S "$agent_link" ]; }; then
        mkdir -p "$agent_dir"
        ln -sfn "$incoming_agent" "$agent_link"
      fi

      if [ -S "$agent_link" ]; then
        export SSH_AUTH_SOCK="$agent_link"
      fi
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
