{ config, ... }:
{
  services.prometheus = {
    enable = true;
    enableReload = true;
    listenAddress = "127.0.0.1";
    globalConfig.scrape_interval = "15s";
    exporters.node = {
      enable = true;
      listenAddress = "127.0.0.1";
    };
    scrapeConfigs = [
      {
        job_name = "prometheus";
        static_configs = [ { targets = [ "127.0.0.1:${toString config.services.prometheus.port}" ]; } ];
      }
      {
        job_name = "hatchi-node";
        static_configs = [
          { targets = [ "127.0.0.1:${toString config.services.prometheus.exporters.node.port}" ]; }
        ];
      }
    ];
  };
  services.grafana = {
    enable = true;
    settings = {
      server = {
        http_addr = "127.0.0.1";
        http_port = 3001;
        domain = "grafana.${config.my.hatchi.domain}";
        root_url = "https://grafana.${config.my.hatchi.domain}";
      };
      security = {
        cookie_secure = true;
        admin_user = "daniel";
        admin_password = "$__file{${config.sops.secrets.grafana-password.path}}";
        secret_key = "$__file{${config.sops.secrets.grafana-key.path}}";
      };
      "auth.anonymous".enabled = false;
      analytics = {
        reporting_enabled = false;
        check_for_updates = false;
      };
    };
    provision = {
      enable = true;
      datasources.settings.datasources = [
        {
          name = "Prometheus";
          type = "prometheus";
          access = "proxy";
          url = "http://127.0.0.1:${toString config.services.prometheus.port}";
          isDefault = true;
        }
      ];
    };
  };
  sops.secrets.grafana-password = {
    owner = "grafana";
    restartUnits = [ "grafana.service" ];
  };
  sops.secrets.grafana-key = {
    owner = "grafana";
    restartUnits = [ "grafana.service" ];
  };
  services.caddy.virtualHosts."grafana.${config.my.hatchi.domain}".extraConfig =
    "reverse_proxy 127.0.0.1:${toString config.services.grafana.settings.server.http_port}";
  my.hatchi.stateUnits = [
    "prometheus"
    "grafana"
  ];
}
