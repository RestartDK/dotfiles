{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
let
  system = pkgs.stdenv.hostPlatform.system;
  mangyWeb = inputs.mangy.packages.${system}.web;
in
{
  services.komga = {
    enable = true;
    group = "media";
    settings.server = {
      address = "127.0.0.1";
      port = 25600;
    };
  };
  services.caddy.virtualHosts."komga.${config.my.domain}".extraConfig =
    "reverse_proxy 127.0.0.1:${toString config.services.komga.settings.server.port}";

  imports = [ inputs.mangy.nixosModules.default ];

  services.mangy = {
    enable = true;
    group = "media";
    # AdGuard Home already listens on 127.0.0.1:3000.
    server.port = 3002;
    environmentFile = config.my.hatchi.secretFiles.mangyEnv;
  };

  services.postgresql = {
    ensureDatabases = [ "mangy" ];
    ensureUsers = [
      {
        name = "mangy";
        ensureDBOwnership = true;
      }
    ];
  };

  # ensureDatabases/ensureUsers only apply to freshly initialized clusters;
  # hatchi's cluster predates mangy, so create the role and database
  # idempotently before the migrations run.
  systemd.services.mangy-db-setup = {
    description = "Create the mangy database role and database";
    after = [ "postgresql.service" ];
    before = [ "mangy-migrate.service" ];
    requiredBy = [ "mangy-migrate.service" ];
    path = [ config.services.postgresql.package ];
    serviceConfig = {
      Type = "oneshot";
      User = "postgres";
    };
    script = ''
      psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='mangy'" | grep -q 1 || psql -c "CREATE ROLE mangy LOGIN"
      psql -tAc "SELECT 1 FROM pg_database WHERE datname='mangy'" | grep -q 1 || createdb -O mangy mangy
    '';
  };

  services.caddy.virtualHosts."mangy.${config.my.domain}".extraConfig = ''
    handle /api/* {
      reverse_proxy 127.0.0.1:${toString config.services.mangy.server.port}
    }
    handle {
      root * ${mangyWeb}
      try_files {path} /index.html
      file_server
    }
  '';

  my.hatchi = {
    stateUnits = [
      "komga"
      "mangy-migrate"
      "mangy-server"
      "mangy-worker"
    ];
    mediaUnits = [
      "komga"
      "mangy-worker"
    ];
  };

  users.users.komga.extraGroups = [ "media" ];
  systemd.services.komga.serviceConfig = {
    StateDirectoryMode = "0700";
    ReadOnlyPaths = [ "/srv/media" ];
    Environment = "JAVA_TOOL_OPTIONS=-Xmx512m";
  };

  sops.secrets."mangy-env" = lib.mkIf (!config.my.hatchi.onepassword.enable) {
    restartUnits = [
      "mangy-server.service"
      "mangy-worker.service"
    ];
    mode = "0400";
  };
}
