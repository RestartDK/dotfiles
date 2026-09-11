{ config, lib, ... }:
let
  remote = config.my.hatchi.remoteNana;
in
{
  services.caddy.virtualHosts = {
    "ollama.${config.my.hatchi.domain}".extraConfig =
      if remote == null then
        ''respond "Nana endpoint deferred" 503''
      else
        "reverse_proxy ${remote.ollama}";
    "opencode.${config.my.hatchi.domain}".extraConfig =
      if remote == null then
        ''respond "Nana endpoint deferred" 503''
      else
        "reverse_proxy ${remote.opencode}";
  };
  services.prometheus.scrapeConfigs = lib.optionals (remote != null) [
    {
      job_name = "srv-nana-node";
      static_configs = [ { targets = [ remote.nodeExporter ]; } ];
    }
  ];
}
