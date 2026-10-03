{
  config,
  ...
}:

{
  services.harmonia.cache = {
    enable = true;
    signKeyPaths = [ "/var/lib/nix-cache/secret" ];
  };

  services.caddy.virtualHosts."cache.${config.my.domain}".extraConfig =
    "reverse_proxy localhost:5000";
}
