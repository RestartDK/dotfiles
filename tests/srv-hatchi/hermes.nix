{
  pkgs,
  self,
  privateValues,
}:
let
  inherit (pkgs) lib;
  cfg = self.nixosConfigurations.srv-hatchi.config;
  uncredentialed =
    (self.nixosConfigurations.srv-hatchi.extendModules {
      modules = [
        ({ lib, ... }: {
          my.hatchi.hermes.apiKeyReference = lib.mkForce null;
        })
      ];
    }).config;
  units = [
    "hermes-agent"
    "hermes-backend"
  ];
  keyFile = "/run/hatchi-onepassword/hermesGoKey";
  hostname = "hermes.${cfg.my.domain}";
  fixture = pkgs.writeText "hermes-runtime-fixture.json" (
    builtins.toJSON {
      inherit (cfg.services.hermes-agent) settings;
      backend = {
        inherit (cfg.services.hermes-agent.backend) host port;
      };
      dashboardEnvironment = lib.getAttrs [
        "HERMES_DASHBOARD_PUBLIC_URL"
        "HERMES_DASHBOARD_BASIC_AUTH_USERNAME"
      ] cfg.systemd.services.hermes-backend.environment;
      gatewayCommand = toString cfg.systemd.services.hermes-agent.serviceConfig.ExecStart;
      tmpfiles = cfg.systemd.tmpfiles.rules;
      command = toString cfg.systemd.services.hermes-backend.serviceConfig.ExecStart;
      proxy = cfg.services.caddy.virtualHosts.${hostname}.extraConfig;
      caddy = lib.getExe cfg.services.caddy.package;
    }
  );
  glanceWidgets = lib.concatMap (
    page: lib.concatMap (column: column.widgets) page.columns
  ) cfg.services.glance.settings.pages;
  glanceLinks = lib.concatMap (
    widget: lib.concatMap (group: group.links) (widget.groups or [ ])
  ) glanceWidgets;
in
assert cfg.services.hermes-agent.enable;
assert !cfg.services.hermes-agent.container.enable;
assert !cfg.virtualisation.docker.enable && !cfg.virtualisation.podman.enable;
assert cfg.services.hermes-agent.backend.mode == "dashboard";
assert cfg.services.hermes-agent.backend.host == "127.0.0.1";
assert cfg.services.hermes-agent.backend.port == 9119;
assert cfg.services.hermes-agent.environmentFiles == [ ];
assert
  cfg.services.hermes-agent.settings.model == {
    provider = "opencode-go";
    default = "glm-5.3-flash";
  };
assert !(cfg.services.hermes-agent.settings ? dashboard);
assert !(cfg.systemd.services.hermes-agent.environment ? HERMES_DASHBOARD_PUBLIC_URL);
assert !(cfg.systemd.services.hermes-agent.environment ? HERMES_DASHBOARD_BASIC_AUTH_USERNAME);
assert
  cfg.systemd.services.hermes-backend.environment.HERMES_DASHBOARD_PUBLIC_URL
  == "https://${hostname}";
assert
  cfg.systemd.services.hermes-backend.environment.HERMES_DASHBOARD_BASIC_AUTH_USERNAME == "daniel";
assert cfg.services.hermes-agent.stateDir == "/var/lib/hermes";
assert cfg.users.users.hermes.isSystemUser;
assert cfg.users.users.hermes.extraGroups == [ ];
assert !(uncredentialed.services.onepassword-secrets.secrets ? hermesGoKey);
assert !(cfg.services.onepassword-secrets.secrets ? hermesEnv);
assert cfg.my.hatchi.hermes.apiKeyReference == privateValues.hatchiHermesApiKeyReference;
assert lib.hasSuffix "/credential" cfg.my.hatchi.hermes.apiKeyReference;
assert
  cfg.my.hatchi.hermes.apiKeyReference != privateValues.personalSecretReferences.opencodeApiKey;
assert
  builtins.elemAt (lib.splitString "/" cfg.my.hatchi.hermes.apiKeyReference) 2
  == builtins.elemAt (lib.splitString "/" privateValues.hatchiOnepasswordReferences.glancePassword) 2;
assert
  cfg.services.onepassword-secrets.secrets.hermesGoKey.reference
  == cfg.my.hatchi.hermes.apiKeyReference;
assert cfg.services.onepassword-secrets.secrets.hermesGoKey.mode == "0400";
assert cfg.services.onepassword-secrets.secrets.hermesGoKey.owner == "root";
assert cfg.services.onepassword-secrets.secretPaths.hermesGoKey == keyFile;
assert builtins.all (
  unit:
  let
    service = cfg.systemd.services.${unit};
  in
  service.serviceConfig.User == "hermes"
  && service.environment.HERMES_HOME == "/var/lib/hermes/.hermes"
  && service.unitConfig.ConditionPathExists == keyFile
  && builtins.elem "OPENCODE_GO_API_KEY:${keyFile}" service.serviceConfig.LoadCredential
  && !(service.serviceConfig ? EnvironmentFile)
  && !service.serviceConfig.ProtectHome
  && builtins.elem "/home" service.serviceConfig.InaccessiblePaths
  && builtins.elem "/root" service.serviceConfig.InaccessiblePaths
  && !(builtins.elem "/run/user" service.serviceConfig.InaccessiblePaths)
  && service.serviceConfig.NoNewPrivileges
  && service.serviceConfig.ProtectSystem == "strict"
  && service.serviceConfig.CapabilityBoundingSet == ""
  && service.serviceConfig.UMask == "0077"
  && builtins.elem cfg.my.hatchi.secretService service.requires
  && builtins.elem cfg.my.hatchi.secretService service.after
  && builtins.elem cfg.my.hatchi.secretService service.partOf
  && !(builtins.elem "/srv" (service.unitConfig.RequiresMountsFor or [ ]))
) units;
assert
  cfg.systemd.services.hermes-agent.serviceConfig.LoadCredential == [
    "OPENCODE_GO_API_KEY:${keyFile}"
  ];
assert builtins.elem
  "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD:${cfg.my.hatchi.secretFiles.glancePassword}"
  cfg.systemd.services.hermes-backend.serviceConfig.LoadCredential;
assert !(builtins.elem 9119 cfg.networking.firewall.allowedTCPPorts);
assert cfg.services.caddy.virtualHosts.${hostname}.useACMEHost == cfg.my.domain;
assert builtins.elem hostname cfg.my.hatchi.edgeNames;
assert lib.any (link: link.url == "https://${hostname}") glanceLinks;
assert lib.any (
  widget:
  lib.any (site: site.title == "Hermes" && site.check-url == "http://127.0.0.1:9119/api/health") (
    widget.sites or [ ]
  )
) glanceWidgets;
pkgs.runCommand "srv-hatchi-hermes" { } ''
  ${cfg.services.hermes-agent.package.hermesVenv}/bin/python3 ${../hermes/dashboard.py} ${cfg.services.hermes-agent.package} ${fixture}
  touch $out
''
