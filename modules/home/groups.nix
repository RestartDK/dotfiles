{ ... }:

{
  imports = [
    ./live-config-options.nix
    ./retire-checkout-links.nix
    ./dotfiles-sync.nix
    ./shell
    ./editors
    ./terminal
    ./agents
    ./desktop
  ];
}
