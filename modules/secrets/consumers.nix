{
  config,
  lib,
  ...
}:
let
  cfg = config.my.secrets;
  consumerPaths = {
    piKeyFile = [
      "my"
      "ai"
      "openrouterKeyFile"
    ];
  };
  wiring = lib.concatMap (
    kind:
    let
      keyName = cfg.consumers.${kind};
    in
    lib.optional (cfg.keys ? ${keyName}) (
      lib.setAttrByPath (consumerPaths.${kind}
        or (throw "my.secrets: unknown consumer '${kind}', expected one of ${lib.concatStringsSep ", " (lib.attrNames consumerPaths)}")
      ) cfg.paths.${keyName}
    )
  ) (lib.attrNames cfg.consumers);
in
{
  options.my.secrets.consumers = lib.mkOption {
    type = lib.types.attrsOf lib.types.str;
    default = { };
    description = "Consumers keyed by kind that read a declared key. piKeyFile points my.ai.openrouterKeyFile at the named key.";
  };

  config = {
    assertions = lib.mapAttrsToList (kind: keyName: {
      assertion = cfg.keys ? ${keyName};
      message = "my.secrets.consumers.${kind} reads undeclared key '${keyName}'";
    }) cfg.consumers;

    home-manager.users.${cfg.userName} = lib.mkIf (wiring != [ ]) (lib.mkMerge wiring);
  };
}
