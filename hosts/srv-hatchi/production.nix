{ config, network, ... }:
{
  my.hatchi.onepassword.enable = true;
  my.hatchi.onepassword.references = network.hatchiOnepasswordReferences;

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
