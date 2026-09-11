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
      adminuser = "daniel";
      adminpassFile = config.sops.secrets.nextcloud-admin.path;
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
  services.postgresql.enableTCPIP = false;
  services.caddy.virtualHosts.${name}.extraConfig = "reverse_proxy 127.0.0.1:11000";
  sops.secrets.nextcloud-admin.restartUnits = [ "nextcloud-setup.service" ];
  my.hatchi.stateUnits = [
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
