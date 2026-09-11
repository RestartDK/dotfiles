{ pkgs, self }:
let
  inherit (pkgs) lib;
  source = builtins.fromJSON (builtins.readFile ./source-manifest.json);
  sorted = lib.sort builtins.lessThan;
  guarded =
    unit:
    builtins.all
      (
        dependency:
        builtins.elem dependency cfg.systemd.services.${unit}.requires
        && builtins.elem dependency cfg.systemd.services.${unit}.after
        && lib.hasInfix dependency cfg.systemd.units."${unit}.service".text
      )
      [
        "hatchi-admission.service"
        "sops-install-secrets.service"
      ];
  anywhereStub = pkgs.writeShellScriptBin "nixos-anywhere" ''
    printf '%s\n' "$@" >> "$UPSTREAM_CALLS"
  '';
  cfg = self.nixosConfigurations.srv-hatchi.config;
  bootstrap = self.nixosConfigurations.srv-hatchi-bootstrap.config;
  inventory = builtins.fromJSON (builtins.readFile ./inventory.json);
  routes = lib.sort builtins.lessThan (
    (map (entry: "${entry.route}.${cfg.my.hatchi.domain}") (
      builtins.filter (entry: entry.route != null) inventory
    ))
    ++ [
      "ollama.${cfg.my.hatchi.domain}"
      "opencode.${cfg.my.hatchi.domain}"
    ]
  );
  destructive = [
    "disko"
    "diskoNoDeps"
    "format"
    "destroy"
    "diskoScript"
    "diskoScriptNoDeps"
    "formatScript"
    "destroyScript"
    "destroyFormatMount"
  ];
in
assert builtins.length inventory == 17;
assert builtins.length source.services == 17;
assert sorted (map (entry: entry.source) inventory) == map (entry: entry.name) source.services;
assert
  builtins.filter (entry: entry.unit == null) inventory == [
    {
      source = "portainer";
      unit = null;
      route = null;
    }
  ];
assert !(builtins.elem "open-webui" (map (entry: entry.source) inventory));
assert builtins.length (lib.unique (map (entry: entry.source) inventory)) == 17;
assert !(builtins.hasAttr "nixos-anywhere" self.apps.${pkgs.stdenv.hostPlatform.system});
assert bootstrap.networking.firewall.allowedTCPPorts == [ 22 ];
assert cfg.networking.firewall.allowedTCPPorts == [ ];
assert cfg.networking.firewall.allowedUDPPorts == [ ];
assert cfg.networking.firewall.trustedInterfaces == [ ];
assert cfg.systemd.services.sonarr.serviceConfig.StateDirectory == "sonarr";
assert cfg.services.qbittorrent.serverConfig == { };
assert cfg.services.grafana.settings.security.cookie_secure;
assert cfg.services.couchdb.configFile == "/run/couchdb/local.ini";
assert lib.hasSuffix cfg.services.couchdb.configFile
  cfg.systemd.services.couchdb.environment.ERL_FLAGS;
assert cfg.services.couchdb.extraConfigFiles == [ ];
assert cfg.services.couchdb.adminPass == null;
assert builtins.all guarded cfg.my.hatchi.stateUnits;
assert guarded "acme-${cfg.my.hatchi.domain}";
assert guarded "acme-order-renew-${cfg.my.hatchi.domain}";
assert builtins.length (builtins.filter (entry: entry.unit != null) inventory) == 16;
assert builtins.attrNames cfg.services.caddy.virtualHosts == routes;
assert builtins.all (
  name: !(builtins.hasAttr name cfg.system.build) && !(builtins.hasAttr name bootstrap.system.build)
) destructive;
assert
  cfg.virtualisation.docker.enable == false
  && cfg.virtualisation.podman.enable == false
  && cfg.services.cockpit.enable == false;
assert cfg.my.hatchi.network == null && cfg.my.hatchi.remoteNana == null;
assert lib.versions.major cfg.services.nextcloud.package.version == "33";
assert self.hatchiCommissioning.state == "uncommissioned";
assert
  builtins.attrNames self.deploy.nodes == [
    "srv-hatchi"
    "srv-nana"
  ];
assert self.deploy.autoRollback && self.deploy.magicRollback;
assert self.deploy.nodes.srv-hatchi.hostname == "uncommissioned.invalid";
assert self.nixosConfigurations.srv-nana.config.virtualisation.docker.enable;
pkgs.runCommand "srv-hatchi-policy"
  {
    nativeBuildInputs = [
      pkgs.bash
      pkgs.git
      pkgs.jq
      pkgs.yq-go
      pkgs.coreutils
      pkgs.diffutils
      pkgs.gnugrep
      pkgs.findutils
    ];
    ROOT = self;
    SOURCE_COMPOSE = pkgs.fetchurl { inherit (source) url sha256; };
    INSTALL_VERIFIER = lib.getExe (
      import ./install-vm.nix {
        inherit pkgs;
        flake = self;
        anywhere = anywhereStub;
      }
    );
    QBITTORRENT_RENDERER = lib.getExe (
      import ../../hosts/srv-hatchi/services/qbittorrent-config.nix {
        inherit pkgs;
        domain = cfg.my.hatchi.domain;
      }
    );
    ADGUARD_RENDERER = lib.getExe (
      import ../../hosts/srv-hatchi/adguard-credentials.nix { inherit pkgs; }
    );
  }
  ''
    bash ${./policy.sh}
    touch $out
  ''
