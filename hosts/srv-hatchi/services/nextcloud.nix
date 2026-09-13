{
  config,
  lib,
  pkgs,
  ...
}:
let
  name = "nextcloud.${config.my.hatchi.domain}";
in
{
  services.nextcloud = {
    enable = true;
    package = pkgs.nextcloud33;
    hostName = name;
    https = true;
    database.createLocally = true;
    configureRedis = true;
    config = {
      dbtype = "pgsql";
      adminuser = null;
      adminpassFile = null;
    };
    settings = {
      trusted_proxies = [ "127.0.0.1" ];
      overwriteprotocol = "https";
    };
  };
  services.nginx.virtualHosts.${name} = {
    listen = [
      {
        addr = "127.0.0.1";
        port = 11000;
      }
    ];
    forceSSL = lib.mkForce false;
    enableACME = lib.mkForce false;
  };
  systemd.services = {
    nextcloud-admin = {
      description = "Bootstrap the first Nextcloud administrator";
      wantedBy = [ "multi-user.target" ];
      requires = [ "nextcloud-setup.service" ];
      after = [ "nextcloud-setup.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "nextcloud";
        LoadCredential = [ "adminpass:${config.my.hatchi.secretFiles.nextcloudPassword}" ];
      };
      script = ''
        users=$(${lib.getExe config.services.nextcloud.occ} user:list --limit=1 --output=json)
        if [ "$(${pkgs.jq}/bin/jq 'length' <<< "$users")" -eq 0 ]; then
          export NC_PASS="$(< "$CREDENTIALS_DIRECTORY/adminpass")"
          ${lib.getExe config.services.nextcloud.occ} user:add --password-from-env --group=admin daniel
        fi
      '';
    };
    nginx = {
      requires = [ "nextcloud-admin.service" ];
      after = [ "nextcloud-admin.service" ];
    };
  };
  services.postgresql.enableTCPIP = false;
  services.caddy.virtualHosts.${name}.extraConfig = "reverse_proxy 127.0.0.1:11000";
  sops.secrets.nextcloud-admin = lib.mkIf (!config.my.hatchi.onepassword.enable) {
    restartUnits = [ "nextcloud-admin.service" ];
  };
  my.hatchi.stateUnits = [
    "nextcloud-admin"
    "nextcloud-setup"
    "nextcloud-cron"
    "nextcloud-update-db"
    "phpfpm-nextcloud"
    "nginx"
    "postgresql"
    "postgresql-setup"
    "redis-nextcloud"
  ];
}
