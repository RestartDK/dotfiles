{ lib, ... }:
let
  inherit (lib) mkOption types;
  endpoint = types.strMatching "[a-zA-Z0-9.-]+:[0-9]+";
in
{
  options.my.hatchi = {
    domain = mkOption {
      type = types.strMatching "[a-z0-9.-]+\\.[a-z]+";
      default = "chateauducipieres.com";
    };
    network = mkOption {
      default = null;
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
    remoteNana = mkOption {
      default = null;
      type = types.nullOr (
        types.submodule {
          options = {
            ollama = mkOption { type = endpoint; };
            opencode = mkOption { type = endpoint; };
            nodeExporter = mkOption { type = endpoint; };
            glanceAgent = mkOption { type = endpoint; };
          };
        }
      );
    };
    stateUnits = mkOption {
      type = types.listOf types.str;
      default = [ ];
      internal = true;
    };
    mediaUnits = mkOption {
      type = types.listOf types.str;
      default = [ ];
      internal = true;
    };
  };
}
