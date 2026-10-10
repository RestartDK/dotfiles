{ ... }:

{
  imports = [
    ./live-config-options.nix
    ./retire-checkout-links.nix
    ./shell
    ./editors
    ./terminal
    ./agents
    ./desktop
    ../theme/default.nix
  ];
}
