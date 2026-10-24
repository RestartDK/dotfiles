{
  config,
  lib,
  ...
}:
let
  domain = config.my.domain;
  secrets = config.my.hatchi.secretFiles;

  url = name: "https://${name}.${domain}";
  link = name: {
    title = name;
    url = url name;
  };

  sites = [
    {
      title = "AdGuard";
      url = "http://127.0.0.1:3000/login.html";
      icon = "sh:adguard-home";
    }
    {
      title = "Jellyfin";
      url = "http://127.0.0.1:8096/health";
      icon = "sh:jellyfin";
    }
    {
      title = "Seerr";
      url = "http://127.0.0.1:5055/api/v1/status";
      icon = "sh:jellyseerr";
    }
    {
      title = "Radarr";
      url = "http://127.0.0.1:7878/ping";
      icon = "sh:radarr";
    }
    {
      title = "Sonarr";
      url = "http://127.0.0.1:8989/ping";
      icon = "sh:sonarr";
    }
    {
      title = "Prowlarr";
      url = "http://127.0.0.1:9696/ping";
      icon = "sh:prowlarr";
    }
    {
      title = "qBittorrent";
      url = "http://127.0.0.1:8080/";
      icon = "sh:qbittorrent";
    }
    {
      title = "Komga";
      url = "http://127.0.0.1:25600/";
      icon = "sh:komga";
    }
    {
      title = "Mangy";
      url = "http://127.0.0.1:3002/";
      icon = "mdi:book-open-page-variant-outline";
    }
    {
      title = "Nextcloud";
      url = "http://127.0.0.1:11000/status.php";
      icon = "sh:nextcloud";
    }
    {
      title = "Miniflux";
      url = "http://127.0.0.1:12000/healthcheck";
      icon = "sh:miniflux";
    }
    {
      title = "Home Assistant";
      url = "http://127.0.0.1:8123/";
      icon = "sh:home-assistant";
    }
    {
      title = "Grafana";
      url = "http://127.0.0.1:3001/api/health";
      icon = "sh:grafana";
    }
  ];

  serverStats = {
    type = "server-stats";
    servers = [
      {
        type = "local";
        name = "Hatchi";
      }
    ]
    ++ lib.optionals (config.my.hatchi.remoteNana != null) [
      {
        type = "remote";
        name = "Nana";
        url = "http://${config.my.hatchi.remoteNana.glanceAgent}";
      }
    ];
  };

  servicesMonitor = {
    type = "monitor";
    title = "Services";
    sites = sites;
  };

  bookmarks = {
    type = "bookmarks";
    groups = [
      {
        title = "Media";
        links = map link [
          "jellyfin"
          "seerr"
          "radarr"
          "sonarr"
          "prowlarr"
          "qbittorrent"
          "komga"
          "mangy"
        ];
      }
      {
        title = "Everything else";
        links = map link [
          "nextcloud"
          "homeassistant"
          "miniflux"
          "grafana"
          "dashboard"
          "adguard"
        ];
      }
    ];
  };

  dnsHeaders = {
    Authorization._secret = secrets.adguardGlanceAuth;
  };

  feedHeaders = {
    X-Auth-Token._secret = secrets.minifluxApiKey;
  };
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
        secret-key._secret = secrets.glanceKey;
        users.daniel.password._secret = secrets.glancePassword;
      };
      pages = [
        {
          name = "Home";
          columns = [
            {
              size = "small";
              widgets = [
                {
                  type = "clock";
                  hour-format = "24h";
                }
                serverStats
              ];
            }
            {
              size = "full";
              widgets = [
                bookmarks
                servicesMonitor
              ];
            }
          ];
        }
        {
          name = "Infra";
          columns = [
            {
              size = "full";
              widgets = [
                servicesMonitor
                {
                  type = "bookmarks";
                  groups = [
                    {
                      title = "Operate";
                      links = [
                        (link "grafana")
                        (link "cache")
                      ];
                    }
                  ];
                }
              ];
            }
          ];
        }
        {
          name = "House";
          columns = [
            {
              size = "full";
              widgets = [
                {
                  type = "custom-api";
                  title = "DNS";
                  title-url = url "adguard";
                  url = "http://127.0.0.1:3000/control/stats";
                  headers = dnsHeaders;
                  template = ''
                    <div class="flex justify-between text-center">
                      <div>
                        <div class="size-h3 color-highlight">{{ .JSON.Int "num_dns_queries" | formatNumber }}</div>
                        <div class="size-h6 color-subdue">queries</div>
                      </div>
                      <div>
                        <div class="size-h3 color-highlight">{{ .JSON.Int "num_blocked_filtering" | formatNumber }}</div>
                        <div class="size-h6 color-subdue">blocked</div>
                      </div>
                      <div>
                        <div class="size-h3 color-highlight">{{ .JSON.String "avg_processing_time" }}</div>
                        <div class="size-h6 color-subdue">avg seconds</div>
                      </div>
                    </div>
                  '';
                }
              ];
            }
          ];
        }
        {
          name = "Feeds";
          width = "slim";
          columns = [
            {
              size = "full";
              widgets = [
                {
                  type = "custom-api";
                  title = "Unread";
                  title-url = url "miniflux";
                  url = "http://127.0.0.1:12000/v1/entries?status=unread&limit=1";
                  headers = feedHeaders;
                  template = ''
                    <div class="flex items-center justify-between">
                      <div class="size-h1 color-highlight">{{ .JSON.Int "total" | formatNumber }}</div>
                      <a class="size-h5 color-primary-if-not-visited" href="{{ printf "%s" "${url "miniflux"}" }}">open Miniflux</a>
                    </div>
                  '';
                }
                {
                  type = "custom-api";
                  title = "Recent unread";
                  url = "http://127.0.0.1:12000/v1/entries?status=unread&limit=15&order=published_at&direction=desc";
                  headers = feedHeaders;
                  template = ''
                    <ul class="list list-gap-10 collapsible-container" data-collapse-after="8">
                      {{ range .JSON.Array "entries" }}
                        <li>
                          <a class="size-h4 color-primary-if-not-visited" href="{{ .String "url" }}">{{ .String "title" }}</a>
                        </li>
                      {{ end }}
                    </ul>
                  '';
                }
              ];
            }
          ];
        }
      ];
    };
  };
  services.caddy.virtualHosts."dashboard.${domain}".extraConfig =
    "reverse_proxy 127.0.0.1:${toString config.services.glance.settings.server.port}";
  my.hatchi.stateUnits = [ "glance" ];
}
