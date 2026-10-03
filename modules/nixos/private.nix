{ inputs, lib, ... }:
let
  values = import inputs.private;
in
{
  options.my.private = lib.mkOption {
    type = lib.types.attrs;
    internal = true;
    default = values;
    description = "The raw private values, for handing to Home Manager through extraSpecialArgs.";
  };

  config = {
    my.domain = lib.mkDefault values.domain;
    my.hosts = lib.mkDefault values.hosts;
    my.network = lib.mkDefault values.network;
    my.host.authorizedKeys = lib.mkDefault values.authorizedKeys.user;
    my.host.rootAuthorizedKeys = lib.mkDefault values.authorizedKeys.root;
  };
}
