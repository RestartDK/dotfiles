{
  config,
  ...
}:

{
  # Hatchi is the binary cache the other hosts substitute from. The signing key
  # is generated once on the host and its public half is declared on the
  # consumers.
  services.harmonia.cache = {
    enable = true;
    signKeyPaths = [ "/var/lib/nix-cache/secret" ];
  };

  services.caddy.virtualHosts."cache.${config.my.hatchi.domain}".extraConfig =
    "reverse_proxy localhost:5000";
}
