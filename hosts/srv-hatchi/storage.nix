{
  config,
  lib,
  pkgs,
  ...
}:
let
  checker = import ./admission.nix {
    inherit pkgs;
    units = lib.unique config.my.hatchi.stateUnits;
  };
in
{
  users.groups.media.gid = 1600;
  systemd.services = lib.mkMerge [
    (lib.genAttrs config.my.hatchi.stateUnits (_: {
      requires = [
        "hatchi-admission.service"
        "sops-install-secrets.service"
      ];
      after = [
        "hatchi-admission.service"
        "sops-install-secrets.service"
      ];
    }))
    (lib.genAttrs config.my.hatchi.mediaUnits (_: {
      unitConfig = {
        RequiresMountsFor = [ "/srv/media" ];
        ConditionPathIsMountPoint = "/srv/media";
      };
      requires = [ "hatchi-media-directories.service" ];
      after = [ "hatchi-media-directories.service" ];
    }))
    {
      hatchi-admission = {
        unitConfig.RequiresMountsFor = [ "/srv/media" ];
        serviceConfig = {
          Type = "oneshot";
          ExecStart = lib.getExe checker;
        };
      };
      hatchi-media-directories = {
        requires = [
          "hatchi-admission.service"
          "sops-install-secrets.service"
        ];
        after = [ "hatchi-admission.service" ];
        unitConfig.ConditionPathIsMountPoint = "/srv/media";
        serviceConfig.Type = "oneshot";
        script = ''
          ${pkgs.coreutils}/bin/install -d -m 2770 -o root -g media /srv/media/{movies,tvshows,manga,downloads}
        '';
      };
    }
  ];
  environment.systemPackages = [
    checker
  ];
}
