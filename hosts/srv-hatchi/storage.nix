{
  config,
  lib,
  pkgs,
  ...
}:
{
  users.groups.media.gid = 1600;
  systemd.services = lib.mkMerge [
    (lib.genAttrs config.my.hatchi.stateUnits (_: {
      requires = [ "sops-install-secrets.service" ];
      after = [ "sops-install-secrets.service" ];
      unitConfig = {
        RequiresMountsFor = [ "/srv/media" ];
        AssertPathIsMountPoint = "/srv/media";
      };
    }))
    (lib.genAttrs config.my.hatchi.mediaUnits (_: {
      requires = [ "hatchi-media-directories.service" ];
      after = [ "hatchi-media-directories.service" ];
    }))
    {
      hatchi-media-directories = {
        requires = [ "sops-install-secrets.service" ];
        after = [ "sops-install-secrets.service" ];
        unitConfig = {
          RequiresMountsFor = [ "/srv/media" ];
          AssertPathIsMountPoint = "/srv/media";
        };
        serviceConfig.Type = "oneshot";
        script = ''
          ${pkgs.coreutils}/bin/install -d -m 2770 -o root -g media /srv/media/{movies,tvshows,manga,downloads}
        '';
      };
    }
  ];
}
