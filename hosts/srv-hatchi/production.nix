{ config, inputs, ... }:
let
  values = import inputs.private;
in
{
  my.hatchi.onepassword.enable = true;
  my.hatchi.onepassword.references = values.hatchiOnepasswordReferences;

  assertions = [
    {
      assertion =
        config.my.network != null
        && config.my.network.clientNetworks != [ ]
        && config.my.network.upstreamDNS != [ ];
      message = "Hatchi requires client networks and upstream DNS resolvers before deployment";
    }
  ];
}
