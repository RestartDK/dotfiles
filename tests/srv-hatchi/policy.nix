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
  nixStub = pkgs.writeShellScriptBin "nix" ''
    printf '%s\n' "$@" >> "$NIX_CALLS"
    if [[ $1 == eval ]]; then printf 'uncommissioned\n'; fi
  '';
  anywhereStub = pkgs.writeShellScriptBin "nixos-anywhere" ''
    printf '%s\n' "$@" >> "$UPSTREAM_CALLS"
  '';
  cfg = self.nixosConfigurations.srv-hatchi.config;
  bootstrap = self.nixosConfigurations.srv-hatchi-bootstrap.config;
  home = cfg.home-manager.users.${cfg.my.host.userName};
  configured =
    module:
    (self.nixosConfigurations.srv-hatchi.extendModules {
      modules = [ module ];
    }).config;
  onePasswordFixture.services.onepassword-secrets.secrets.integrationProbe = {
    reference = "op://fixture/integration/password";
    services = [ "radarr" ];
  };
  withOnePassword = configured onePasswordFixture;
  disabledOnePassword = configured {
    imports = [ onePasswordFixture ];
    services.onepassword-secrets.enable = false;
  };
  withPolling = configured {
    imports = [ onePasswordFixture ];
    services.onepassword-secrets.systemdIntegration.polling.enable = true;
  };
  withoutIntegration = configured {
    imports = [ onePasswordFixture ];
    services.onepassword-secrets.systemdIntegration.enable = false;
  };
  withConfigFile = configured {
    services.onepassword-secrets.configFiles = [
      (pkgs.writeText "opnix-fixture.json" (
        builtins.toJSON {
          secrets = [
            {
              path = "integrationProbe";
              reference = "op://fixture/integration/password";
            }
          ];
        }
      ))
    ];
  };
  renamedUser = configured {
    my.host = {
      userName = "hatchi-fixture";
      homeDirectory = "/srv/home/hatchi-fixture";
    };
  };
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
assert cfg.networking.firewall.trustedInterfaces == [ "lo" ];
assert cfg.systemd.services.sonarr.serviceConfig.StateDirectory == "sonarr";
assert cfg.services.qbittorrent.serverConfig != { };
assert cfg.sops.templates ? "AdGuardHome.yaml";
assert cfg.sops.templates ? "qBittorrent.conf";
assert !cfg.services.adguardhome.mutableSettings;
assert
  cfg.services.adguardhome.settings.users == [
    {
      name = "daniel";
      password = cfg.sops.placeholder.adguard-password;
    }
  ];
assert
  cfg.services.qbittorrent.serverConfig.Preferences."WebUI\\Password_PBKDF2"
  == cfg.sops.placeholder.qbittorrent-password;
assert builtins.all
  (
    entry:
    let
      template = cfg.sops.templates.${entry.name};
    in
    template.mode == "0400"
    && template.uid == 0
    && template.gid == 0
    && template.restartUnits == [ "${entry.unit}.service" ]
    && cfg.systemd.services.${entry.unit}.serviceConfig.LoadCredential == [ "config:${template.path}" ]
  )
  [
    {
      name = "AdGuardHome.yaml";
      unit = "adguardhome";
    }
    {
      name = "qBittorrent.conf";
      unit = "qbittorrent";
    }
  ];
assert cfg.systemd.services.adguardhome.serviceConfig.DynamicUser;
assert lib.hasInfix "install -m600" cfg.systemd.services.adguardhome.preStart;
assert lib.hasInfix "install -Dm600 %d/config" (
  builtins.head cfg.systemd.services.qbittorrent.serviceConfig.ExecStartPre
);
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
assert home.home.username == cfg.my.host.userName;
assert home.home.homeDirectory == cfg.my.host.homeDirectory;
assert cfg.users.users.${cfg.my.host.userName}.home == home.home.homeDirectory;
assert home.my.liveConfig.repoRoot == "${cfg.my.host.homeDirectory}/.config/dotfiles";
assert builtins.all (group: home.my.liveConfig.groups.${group}) [
  "shell"
  "git"
  "editors"
  "terminalTools"
  "multiplexer"
  "agents"
];
assert !home.my.liveConfig.groups.ghostty && !home.my.liveConfig.groups.wayland;
assert builtins.all (name: builtins.elem name (map lib.getName home.home.packages)) [
  "codex"
  "claude-code"
  "opencode"
  "pi"
  "herdr"
  "neovim"
];
assert cfg.programs.zsh.enable;
assert lib.getName cfg.users.users.${cfg.my.host.userName}.shell == "zsh";
assert lib.hasInfix "home-manager" home.home.activationPackage.drvPath;
assert
  renamedUser.home-manager.users.hatchi-fixture.home.homeDirectory == "/srv/home/hatchi-fixture";
assert renamedUser.users.users.hatchi-fixture.home == "/srv/home/hatchi-fixture";
assert
  renamedUser.home-manager.users.hatchi-fixture.my.liveConfig.repoRoot
  == "/srv/home/hatchi-fixture/.config/dotfiles";
assert !(bootstrap ? home-manager);
assert cfg.sops.useSystemdActivation;
assert !cfg.services.onepassword-secrets.enable && !(cfg.sops.secrets ? opnix-token);
assert !(cfg.systemd.services ? opnix-secrets);
assert !disabledOnePassword.services.onepassword-secrets.enable;
assert !(disabledOnePassword.sops.secrets ? opnix-token);
assert !(disabledOnePassword.systemd.services ? opnix-secrets);
assert withConfigFile.services.onepassword-secrets.enable;
assert withOnePassword.services.onepassword-secrets.enable;
assert withOnePassword.services.onepassword-secrets.users == [ ];
assert withOnePassword.services.onepassword-secrets.secrets.integrationProbe.mode == "0600";
assert withOnePassword.services.onepassword-secrets.secrets.integrationProbe.owner == "root";
assert
  withOnePassword.services.onepassword-secrets.tokenFile
  == withOnePassword.sops.secrets.opnix-token.path;
assert withOnePassword.sops.secrets.opnix-token.path == "/run/secrets/opnix-token";
assert withOnePassword.sops.secrets.opnix-token.mode == "0640";
assert withOnePassword.sops.secrets.opnix-token.group == "onepassword-secrets";
assert withOnePassword.sops.secrets.opnix-token.restartUnits == [ "opnix-secrets.service" ];
assert builtins.all
  (
    unit:
    builtins.elem "sops-install-secrets.service" withPolling.systemd.services.${unit}.after
    && builtins.elem "sops-install-secrets.service" withPolling.systemd.services.${unit}.requires
    &&
      lib.hasInfix "Requires=sops-install-secrets.service"
        withPolling.systemd.units."${unit}.service".text
  )
  [
    "opnix-secrets"
    "opnix-secrets-restart"
    "opnix-secrets-poll"
  ];
assert !(withOnePassword.systemd.services ? opnix-secrets-poll);
assert !(withoutIntegration.systemd.services ? opnix-secrets-restart);
assert !(withoutIntegration.systemd.services ? opnix-secrets-poll);
assert builtins.elem "opnix-secrets.service" withOnePassword.systemd.services.radarr.after;
assert builtins.elem "opnix-secrets.service" withOnePassword.systemd.services.radarr.wants;
assert
  withOnePassword.services.onepassword-secrets.secretPaths.integrationProbe
  == "/var/lib/opnix/secrets/integrationProbe";
assert cfg.sops.defaultSopsFile == withOnePassword.sops.defaultSopsFile;
assert cfg.sops.secrets.nextcloud-admin.path == withOnePassword.sops.secrets.nextcloud-admin.path;
pkgs.runCommand "srv-hatchi-policy"
  {
    nativeBuildInputs = [
      pkgs.bash
      pkgs.git
      pkgs.jq
      pkgs.yq-go
      pkgs.sops
      pkgs.coreutils
      pkgs.diffutils
      pkgs.gnugrep
      pkgs.findutils
      pkgs.getconf
      self.packages.${pkgs.stdenv.hostPlatform.system}.opnix
      self.inputs.sops-nix.packages.${pkgs.stdenv.hostPlatform.system}.sops-install-secrets
    ];
    ROOT = self;
    NIX_STUB = nixStub;
    SOURCE_COMPOSE = pkgs.fetchurl { inherit (source) url sha256; };
    INSTALL_VERIFIER = lib.getExe (
      import ./install-vm.nix {
        inherit pkgs;
        flake = self;
        anywhere = anywhereStub;
      }
    );
    SOPS_MANIFEST = pkgs.writeText "hatchi-template-manifest.json" (
      builtins.toJSON {
        secrets = lib.mapAttrsToList (name: secret: {
          inherit name;
          inherit (secret) key mode format;
        }) cfg.sops.secrets;
        templates = lib.mapAttrsToList (name: template: {
          inherit name;
          inherit (template) content mode;
        }) cfg.sops.templates;
        placeholderBySecretName = cfg.sops.placeholder;
      }
    );
  }
  ''
    bash ${./policy.sh}
    touch $out
  ''
