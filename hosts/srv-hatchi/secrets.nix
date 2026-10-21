{
  inputs,
  config,
  lib,
  ...
}:
let
  onePassword = config.services.onepassword-secrets;
  cfg = config.my.hatchi.onepassword;
  templateNames = {
    adguardConfig = "AdGuardHome.yaml";
    qbittorrentConfig = "qBittorrent.conf";
    wifiSecrets = "wpa-secrets.conf";
  };
in
{
  imports = [
    inputs.opnix.nixosModules.default
    ./onepassword.nix
  ];
  options.my.hatchi = {
    secretFiles = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      readOnly = true;
      internal = true;
    };
    secretService = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      internal = true;
    };
  };
  config = {
    my.hatchi = {
      secretFiles =
        lib.mapAttrs (
          name: _: onePassword.secretPaths.${name} or "/run/hatchi-onepassword/${name}"
        ) cfg.references
        // lib.mapAttrs (_: name: "/run/hatchi-secrets/${name}") templateNames;
      secretService = "hatchi-secret-files.service";
    };
    services.onepassword-secrets = {
      enable = lib.mkDefault (onePassword.secrets != { } || onePassword.configFiles != [ ]);
      tokenFile = lib.mkIf (onePassword.enable && cfg.tokenFile != null) cfg.tokenFile;
    };
    system.preSwitchChecks.hatchi-secrets =
      lib.optionalString (onePassword.enable && cfg.tokenFile != null)
        ''
          if ! test -s ${lib.escapeShellArg cfg.tokenFile}; then
            echo "Hatchi's 1Password token must be provisioned before deployment" >&2
            exit 1
          fi
        '';
  };
}
