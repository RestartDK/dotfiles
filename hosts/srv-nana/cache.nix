{
  ...
}:

{
  nix.settings = {
    extra-substituters = [ "https://cache.chateauducipieres.com" ];
    extra-trusted-public-keys = [
      "hatchi-cache-1:LrCQUUSFDL/+vRytC8mskDaygp91ALVrqAZ8jPwweJI="
    ];
  };

  # The cache answers on the tailnet address, so name resolution has to work
  # here; a public resolver stays as the fallback.
  networking.nameservers = [
    "100.85.39.42"
    "1.1.1.1"
  ];
}
