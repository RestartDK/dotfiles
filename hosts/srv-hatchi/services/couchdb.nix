{
  config,
  lib,
  pkgs,
  ...
}:
{
  services.couchdb = {
    enable = true;
    bindAddress = "127.0.0.1";
    logFile = "/var/lib/couchdb/couchdb.log";
    configFile = "/run/couchdb/local.ini";
    extraConfig = {
      couchdb.single_node = true;
      chttpd = {
        require_valid_user = true;
        max_http_request_size = 4294967296;
      };
      httpd.enable_cors = true;
      cors = {
        origins = "app://obsidian.md,capacitor://localhost,http://localhost";
        credentials = true;
        methods = "GET, PUT, POST, HEAD, DELETE";
        headers = "accept, authorization, content-type, origin, referer";
      };
    };
  };
  sops.secrets.couchdb-admin = {
    restartUnits = [ "couchdb.service" ];
  };
  services.caddy.virtualHosts."couchdb.${config.my.hatchi.domain}".extraConfig =
    "reverse_proxy 127.0.0.1:${toString config.services.couchdb.port}";
  systemd.services.couchdb.preStart = lib.mkBefore ''
    ${pkgs.coreutils}/bin/install -m600 "$CREDENTIALS_DIRECTORY/admin" ${config.services.couchdb.configFile}
  '';
  systemd.services.couchdb.serviceConfig = {
    RuntimeDirectory = "couchdb";
    RuntimeDirectoryMode = "0700";
    LoadCredential = [ "admin:${config.sops.secrets.couchdb-admin.path}" ];
    StateDirectory = "couchdb";
    StateDirectoryMode = "0700";
    UMask = "0077";
  };
  my.hatchi.stateUnits = [ "couchdb" ];
}
