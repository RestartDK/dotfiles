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

  networking.nameservers = [
    "100.85.39.42"
    "1.1.1.1"
  ];
}
