{ lib, ... }:
let
  inherit (lib) mkOption types;
  endpoint = types.strMatching "[a-zA-Z0-9.-]+:[0-9]+";
in
{
  options.my.hatchi = {
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
