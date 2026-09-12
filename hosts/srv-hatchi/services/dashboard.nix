{ config, lib, ... }:
let
  names = config.my.hatchi.edgeNames;
in
{
  services.glance = {
    enable = true;
    settings = {
      server = {
        host = "127.0.0.1";
        port = 8081;
        proxied = true;
      };
      auth = {
        secret-key._secret = config.sops.secrets.glance-key.path;
        users.daniel.password._secret = config.sops.secrets.glance-password.path;
      };
      pages = [
        {
          name = "Home";
          columns = [
            {
              size = "full";
              widgets = [
                {
                  type = "clock";
                  hour-format = "24h";
                }
                {
                  type = "bookmarks";
                  groups = [
                    {
                      title = "Services";
                      links = map (name: {
                        title = name;
                        url = "https://${name}";
                      }) names;
                    }
                  ];
                }
              ]
              ++ lib.optionals (config.my.hatchi.remoteNana != null) [
                {
                  type = "server-stats";
                  servers = [
                    {
                      type = "remote";
                      name = "Nana";
                      url = "http://${config.my.hatchi.remoteNana.glanceAgent}";
                    }
                  ];
                }
              ];
            }
          ];
        }
      ];
    };
  };
  sops.secrets.glance-key.restartUnits = [ "glance.service" ];
  sops.secrets.glance-password.restartUnits = [ "glance.service" ];
  services.caddy.virtualHosts."dashboard.${config.my.hatchi.domain}".extraConfig =
    "reverse_proxy 127.0.0.1:${toString config.services.glance.settings.server.port}";
  my.hatchi.stateUnits = [ "glance" ];
}
