{ config, inputs ? { }, lib, pkgs, ... }:

let
  cfg = config.my.twinDevEnvironment;
in
{
  imports = [ ./pi-opencode-netns-wrapper.nix ];

  options.my.twinDevEnvironment.enable =
    lib.mkEnableOption "Daniel's reusable Twin development environment";

  config = lib.mkIf cfg.enable {
    programs.home-manager.enable = true;
    programs.hunk.enable = true;
    services.lorri.enable = true;
    xdg.enable = true;

    # Keep Git identity, aliases, signing, and other host policy in the owning
    # profile while sharing Daniel's development tools across Twin and Cobb.
    home.packages = import ./dev-package-list.nix {
      inherit pkgs inputs;
      agentPackageNames = [ ];
    };

    home.enableNixpkgsReleaseCheck = false;
    my.piNetnsWrapper.enable = true;
  };
}
