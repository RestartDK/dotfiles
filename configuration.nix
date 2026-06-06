# Compatibility entry point for non-flake nixos-rebuild.
# Preferred command:
#   sudo nixos-rebuild switch --flake /etc/nixos#srv-nana
{ ... }:

{
  imports = [ ./hosts/srv-nana ];
}
