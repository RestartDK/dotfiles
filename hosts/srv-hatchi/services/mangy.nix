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
  imports = [ inputs.mangy.nixosModules.default ];

  services.mangy = {
    enable = true;
    group = "media";
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
      "mangy-migrate"
      "mangy-server"
      "mangy-worker"
    ];
    mediaUnits = [ "mangy-worker" ];
  };

  sops.secrets."mangy-env" = lib.mkIf (!config.my.hatchi.onepassword.enable) {
    restartUnits = [
      "mangy-server.service"
      "mangy-worker.service"
    ];
    mode = "0400";
  };
}
