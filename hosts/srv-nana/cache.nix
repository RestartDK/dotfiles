{
  config,
  lib,
  ...
}:

{
  nix.settings = {
    extra-substituters = [ "https://cache.${config.my.domain}" ];
    extra-trusted-public-keys = [
      "hatchi-cache-1:LrCQUUSFDL/+vRytC8mskDaygp91ALVrqAZ8jPwweJI="
    ];
  };

  networking.nameservers = lib.mkForce [
    config.my.hosts.hatchi.lan
    config.my.hosts.hatchi.tailnet
    "1.1.1.1"
    "9.9.9.9"
  ];

  # A connection profile that pins its own DNS outranks the list above, because
  # NetworkManager registers with a better resolvconf metric than the static entry.
  networking.networkmanager.dns = "none";
}
