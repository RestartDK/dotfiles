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
    {
      assertion = config.my.domain != "example.invalid";
      message = "Hatchi requires a real domain from the private input, not the public placeholder";
    }
  ];
}
