{
  config,
  lib,
  ...
}:
let
  cfg = config.my.secrets;
  # Each consumer names the key whose runtime path it writes into a my.* option.
  consumers = {
    piKeyFile = [
      "my"
      "ai"
      "openrouterKeyFile"
    ];
    piOpencodeKeyFile = [
      "my"
      "ai"
      "opencodeKeyFile"
    ];
  };
  wiring = lib.concatLists (
    lib.mapAttrsToList (
      name: target:
      let
        keyName = cfg.consumers.${name};
      in
      lib.optional (keyName != null && cfg.keys ? ${keyName}) (
        lib.setAttrByPath target cfg.paths.${keyName}
      )
    ) consumers
  );
in
{
  options.my.secrets.consumers = {
    piKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Key whose runtime file my.ai.openrouterKeyFile points at.";
    };
    piOpencodeKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Key whose runtime file my.ai.opencodeKeyFile points at.";
    };
  };

  config = {
    assertions = lib.mapAttrsToList (name: keyName: {
      assertion = cfg.keys ? ${keyName};
      message = "my.secrets.consumers.${name} reads undeclared key '${keyName}'";
    }) (lib.filterAttrs (_: keyName: keyName != null) cfg.consumers);

    home-manager.users.${cfg.userName} = lib.mkIf (wiring != [ ]) (lib.mkMerge wiring);
  };
}
