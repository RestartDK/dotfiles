{ config, inputs, ... }:
{
  imports = [ (import inputs.private) ];

  my.hatchi.onepassword.enable = true;

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
      message = "Hatchi requires the private input; the public tree only carries a placeholder domain";
    }
  ];
}
