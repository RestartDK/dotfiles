{ lib, ... }:
let
  inherit (lib) mkOption types;
in
{
  options.my.domain = mkOption {
    type = types.strMatching "[a-z0-9.-]+\\.[a-z]+";
    default = "example.invalid";
    description = "Public domain the house serves from. Shared by every host that terminates TLS for it. The real value comes from the private input, so the public tree carries only this placeholder.";
  };
  options.my.hosts = mkOption {
    default = { };
    description = "Addresses of the house hosts, by name, with a lan and a tailnet address each. From the private input.";
    type = types.attrsOf (
      types.submodule {
        options = {
          lan = mkOption { type = types.strMatching "[0-9.]+"; };
          tailnet = mkOption { type = types.strMatching "[0-9.]+"; };
        };
      }
    );
  };
  options.my.network = mkOption {
    default = null;
    description = "The house network: the addressing and firewall zones every host shares.";
    type = types.nullOr (
      types.submodule {
        options = {
          dnsAnswer = mkOption { type = types.strMatching "[0-9.]+"; };
          clientNetworks = mkOption { type = types.listOf (types.strMatching "[0-9a-fA-F:./]+"); };
          adminNetworks = mkOption { type = types.listOf (types.strMatching "[0-9a-fA-F:./]+"); };
          upstreamDNS = mkOption { type = types.listOf types.str; };
        };
      }
    );
  };
}
