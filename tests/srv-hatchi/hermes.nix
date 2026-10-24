{
  pkgs,
  self,
}:
let
  inherit (pkgs) lib;
  cfg = self.nixosConfigurations.srv-hatchi.config;
  credentialed =
    (self.nixosConfigurations.srv-hatchi.extendModules {
      modules = [
        ({ lib, ... }: {
          my.hatchi.hermes.environmentReference = lib.mkForce "op://fixture/hermes/environment";
        })
      ];
    }).config;
  units = [
    "hermes-agent"
    "hermes-backend"
  ];
  environmentFile = "/run/hatchi-onepassword/hermesEnv";
  fixture = pkgs.writeText "hermes-runtime-fixture.json" (
    builtins.toJSON {
      inherit (cfg.services.hermes-agent) settings;
      tmpfiles = cfg.systemd.tmpfiles.rules;
    }
  );
in
assert cfg.services.hermes-agent.enable;
assert !cfg.services.hermes-agent.container.enable;
assert !cfg.virtualisation.docker.enable && !cfg.virtualisation.podman.enable;
assert cfg.services.hermes-agent.backend.mode == "dashboard";
assert cfg.services.hermes-agent.backend.host == "127.0.0.1";
assert cfg.services.hermes-agent.backend.port == 9119;
assert cfg.services.hermes-agent.environmentFiles == [ ];
assert cfg.services.hermes-agent.stateDir == "/var/lib/hermes";
assert cfg.users.users.hermes.isSystemUser;
assert cfg.users.users.hermes.extraGroups == [ ];
assert !(cfg.services.onepassword-secrets.secrets ? hermesEnv);
assert
  credentialed.services.onepassword-secrets.secrets.hermesEnv.reference
  == "op://fixture/hermes/environment";
assert credentialed.services.onepassword-secrets.secrets.hermesEnv.mode == "0400";
assert credentialed.services.onepassword-secrets.secrets.hermesEnv.owner == "root";
assert credentialed.services.onepassword-secrets.secretPaths.hermesEnv == environmentFile;
assert builtins.all (
  unit:
  let
    service = cfg.systemd.services.${unit};
  in
  service.serviceConfig.User == "hermes"
  && service.environment.HERMES_HOME == "/var/lib/hermes/.hermes"
  && service.unitConfig.ConditionPathExists == environmentFile
  && service.serviceConfig.EnvironmentFile == [ environmentFile ]
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
assert !(builtins.elem 9119 cfg.networking.firewall.allowedTCPPorts);
assert
  !(lib.any (name: lib.hasPrefix "hermes." name) (
    builtins.attrNames cfg.services.caddy.virtualHosts
  ));
pkgs.runCommand "srv-hatchi-hermes"
  {
  }
  ''
    ${cfg.services.hermes-agent.package.hermesVenv}/bin/python3 ${../hermes/dashboard.py} ${cfg.services.hermes-agent.package} ${fixture}
    touch $out
  ''
