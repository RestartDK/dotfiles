{ ... }:

{
  imports = [
    ./live-config-options.nix
    ./herdr-durable.nix
    ./retire-checkout-links.nix
    ./shell
    ./editors
    ./terminal
    ./agents
    ./desktop
    ../theme/default.nix
  ];
}
