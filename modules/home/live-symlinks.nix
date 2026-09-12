{ ... }:

{
  imports = [
    ./live-config-options.nix
    ./dotfiles-sync.nix
    ./shell
    ./editors
    ./terminal
    ./agents
    ./desktop
  ];
}
