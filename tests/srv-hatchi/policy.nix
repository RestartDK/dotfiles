{
  pkgs,
  self,
  inputs,
}:
let
  inherit (pkgs) lib;
  hatchiPublicKey = lib.strings.trim (builtins.readFile ../../config/ssh/public-keys/hatchi.pub);
  secretsBefore =
    unit:
    builtins.elem "hatchi-secret-files.service" cfg.systemd.services.${unit}.requires
    && builtins.elem "hatchi-secret-files.service" cfg.systemd.services.${unit}.after
    && lib.hasInfix "hatchi-secret-files.service" cfg.systemd.units."${unit}.service".text;
  nixStub = pkgs.writeShellScriptBin "nix" ''
    printf '%s\n' "$@" >> "$NIX_CALLS"
    if [[ $1 == eval ]]; then
      if [[ $* == *disko.devices.disk.system.device ]]; then
        printf '%s\n' /dev/disk/by-id/fixture-system
      elif [[ $* == *disko.devices.disk.data.device ]]; then
        printf '%s\n' /dev/disk/by-id/fixture-data
      else
        printf '%s\n' x86_64-linux
      fi
    elif [[ $1 == run && -n "''${NIX_STUB_INSPECT_EXTRA_FILES:-}" ]]; then
      shift
      while (($#)); do
        if [[ $1 == --extra-files ]]; then
          staging_root="$2"
          break
        fi
        shift
      done
      checkout="$staging_root/home/dkumlin/.config/dotfiles"
      test -d "$checkout/.git"
      test -f "$checkout/hosts/srv-hatchi/hardware-configuration.nix"
      cmp "$HOME/.local/state/hatchi-bootstrap/var/lib/opnix/token" "$staging_root/var/lib/opnix/token"
      test "$(stat -c %a "$staging_root/var/lib/opnix/token")" = 600
      git -C "$checkout" rev-parse HEAD > "$NIX_STUB_INSPECT_EXTRA_FILES"
    fi
  '';
  sshStub = pkgs.writeShellScriptBin "ssh" ''
    printf '%s\n' "$@" >> "$SSH_CALLS"
    cat >/dev/null
    exit "''${SSH_STUB_STATUS:-0}"
  '';
  production = self.nixosConfigurations.srv-hatchi.config;
  cfg = configured { };
  storage =
    (inputs.nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        inputs.disko.nixosModules.disko
        (import ../../hosts/srv-hatchi/disk-layout.nix {
          systemDisk = "/dev/disk/by-id/fixture-system";
          dataDisk = "/dev/disk/by-id/fixture-data";
        })
        { system.stateVersion = "26.05"; }
      ];
    }).config;
  evaluatePhysicalPlatform =
    physicalStorage:
    builtins.tryEval (
      builtins.deepSeq (
        (import ../../hosts/srv-hatchi/physical-platform.nix {
          inherit inputs;
          storage = physicalStorage;
        })
          { inherit lib; }
      ) true
    );
  validPhysicalPlatform = evaluatePhysicalPlatform {
    systemDisk = "/dev/disk/by-id/fixture-system";
    dataDisk = "/dev/disk/by-id/fixture-data";
  };
  unstablePhysicalPlatform = evaluatePhysicalPlatform {
    systemDisk = "/dev/sda";
    dataDisk = "/dev/sdb";
  };
  duplicatePhysicalPlatform = evaluatePhysicalPlatform {
    systemDisk = "/dev/disk/by-id/fixture-system";
    dataDisk = "/dev/disk/by-id/fixture-system";
  };
  missingPhysicalPlatform = evaluatePhysicalPlatform null;
  home = cfg.home-manager.users.${cfg.my.host.userName};
  expectedGoEnv = {
    GOPATH = "${home.home.homeDirectory}/.local/share/go";
    GOBIN = "${home.home.homeDirectory}/.local/bin";
    GOCACHE = "${home.home.homeDirectory}/.cache/go-build";
  };
  configured =
    module:
    (self.nixosConfigurations.srv-hatchi.extendModules {
      modules = [
        { disabledModules = [ ../../hosts/srv-hatchi/production.nix ]; }
        module
      ];
    }).config;
  onePasswordFixture.services.onepassword-secrets.secrets.integrationProbe = {
    reference = "op://fixture/integration/password";
    services = [ "radarr" ];
  };
  withOnePassword = configured onePasswordFixture;
  withAppSecrets = configured {
    my.hatchi.onepassword = {
      tokenFile = "/run/test-opnix-token";
      references = lib.genAttrs (builtins.attrNames cfg.my.hatchi.onepassword.references) (
        name: "op://fixture/credentials/${name}"
      );
    };
  };
  privateMachine = configured (
    { lib, pkgs, ... }:
    import ./onepassword-machine.nix { inherit lib pkgs self; }
  );
  missingAppKeys = configured {
    my.hatchi.onepassword.references = {
      glanceKey = null;
      grafanaKey = null;
    };
  };
  storeToken = configured {
    my.hatchi.onepassword.tokenFile = "${builtins.storeDir}/must-not-be-a-token";
  };
  disabledOnePassword = configured {
    imports = [ onePasswordFixture ];
    services.onepassword-secrets.enable = false;
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
    (map (entry: "${entry.route}.${cfg.my.domain}") (
      builtins.filter (entry: entry.route != null) inventory
    ))
    ++ [
      "homeassistant.${cfg.my.domain}"
      "ollama.${cfg.my.domain}"
      "opencode.${cfg.my.domain}"
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
assert
  builtins.filter (entry: entry.unit == null) inventory == [
    {
      source = "portainer";
      unit = null;
      route = null;
    }
  ];
assert !(builtins.elem "open-webui" (map (entry: entry.source) inventory));
assert !(builtins.hasAttr "nixos-anywhere" self.apps.${pkgs.stdenv.hostPlatform.system});
assert builtins.hasAttr "nixos-anywhere" self.packages.${pkgs.stdenv.hostPlatform.system};
assert
  cfg.disko.devices.disk.system.device
  == "/dev/disk/by-id/ata-LITEON_CV8-8E128-11_SATA_128GB_TW059X3VLOH008BC01G0";
assert cfg.disko.devices.disk.data.device == "/dev/disk/by-id/ata-ST1000LM049-2GH172_WGS2R867";
assert storage.disko.devices.disk.system.device == "/dev/disk/by-id/fixture-system";
assert storage.disko.devices.disk.data.device == "/dev/disk/by-id/fixture-data";
assert storage.fileSystems."/".fsType == "ext4";
assert storage.fileSystems."/boot".fsType == "vfat";
assert storage.fileSystems."/srv".fsType == "ext4";
assert validPhysicalPlatform.success;
assert !unstablePhysicalPlatform.success;
assert !duplicatePhysicalPlatform.success;
assert !missingPhysicalPlatform.success;
assert builtins.elem "nofail" storage.fileSystems."/srv".options;
assert storage.boot.loader.systemd-boot.enable;
assert !storage.boot.loader.grub.enable;
assert cfg.networking.firewall.allowedTCPPorts == [ ];
assert cfg.networking.firewall.allowedUDPPorts == [ ];
assert cfg.networking.firewall.trustedInterfaces == [ "lo" ];
assert
  cfg.networking.firewall.interfaces.tailscale0.allowedTCPPorts == [
    22
    80
    443
  ];
assert
  production.networking.firewall.interfaces.tailscale0.allowedTCPPorts == [
    22
    80
    443
  ];
assert cfg.networking.firewall.interfaces.tailscale0.allowedUDPPorts == [ 53 ];
assert production.networking.firewall.interfaces.tailscale0.allowedUDPPorts == [ 53 ];
assert
  production.services.adguardhome.settings.dns.upstream_dns == production.my.network.upstreamDNS;
assert
  production.services.adguardhome.settings.filtering.rewrites == [
    {
      domain = "*.${production.my.domain}";
      answer = production.my.network.dnsAnswer;
      enabled = true;
    }
  ];
assert production.security.acme.certs.${production.my.domain}.dnsResolver == "1.1.1.1:53";
assert
  production.services.tailscale.extraSetFlags == [
    "--netfilter-mode=off"
    "--advertise-routes=${production.my.network.dnsAnswer}/32"
  ];
assert lib.all (
  range:
  lib.hasInfix "ip saddr ${range} meta l4proto { tcp, udp } th dport { 53 } accept" production.networking.firewall.extraInputRules
) production.my.network.clientNetworks;
assert lib.all (
  range:
  lib.hasInfix "ip saddr ${range} meta l4proto { tcp } th dport { 22 } accept" production.networking.firewall.extraInputRules
) production.my.network.adminNetworks;
assert production.my.hatchi.onepassword.tokenFile == "/var/lib/opnix/token";
assert builtins.all (reference: reference != null) (
  builtins.attrValues production.my.hatchi.onepassword.references
);
assert production.services.onepassword-secrets.enable;
assert lib.hasInfix "/var/lib/opnix/token" production.system.preSwitchChecks.hatchi-secrets;
assert lib.hasInfix "!include /etc/nix/runner-access-tokens.conf" production.nix.extraOptions;
assert lib.hasInfix "runnerAccessToken" production.systemd.services.hatchi-runner-credential.script;
assert lib.elem "hatchi-runner-credential.service"
  production.services.github-runners.hatchi-deploy.serviceOverrides.after;
assert cfg.systemd.services.sonarr.serviceConfig.StateDirectory == "sonarr";
assert cfg.services.qbittorrent.serverConfig != { };
assert cfg.services.mangy.enable;
assert cfg.services.mangy.group == "media";
assert cfg.services.mangy.server.listenAddress == "127.0.0.1";
assert cfg.services.mangy.server.port == 3002;
assert !cfg.services.adguardhome.mutableSettings;
assert
  cfg.services.adguardhome.settings.users == [
    {
      name = "daniel";
      password = "@hatchi-adguard-hash@";
    }
  ];
assert
  cfg.services.qbittorrent.serverConfig.Preferences."WebUI\\Password_PBKDF2"
  == "@hatchi-qbittorrent-hash@";
assert
  cfg.systemd.services.adguardhome.serviceConfig.LoadCredential == [
    "config:/run/hatchi-secrets/AdGuardHome.yaml"
  ];
assert
  cfg.systemd.services.qbittorrent.serviceConfig.LoadCredential == [
    "config:/run/hatchi-secrets/qBittorrent.conf"
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
assert !(cfg.systemd.services ? hatchi-admission);
assert builtins.all (
  unit:
  builtins.elem "/srv" (cfg.systemd.services.${unit}.unitConfig.RequiresMountsFor or [ ])
  && cfg.systemd.services.${unit}.unitConfig.AssertPathIsMountPoint == "/srv"
) (cfg.my.hatchi.stateUnits ++ cfg.my.hatchi.mediaUnits ++ [ "hatchi-media-directories" ]);
assert !(builtins.elem "hatchi-secret-files.service" (cfg.systemd.services.caddy.partOf or [ ]));
assert builtins.all secretsBefore cfg.my.hatchi.stateUnits;
assert secretsBefore "hatchi-media-directories";
assert secretsBefore "acme-${cfg.my.domain}";
assert secretsBefore "acme-order-renew-${cfg.my.domain}";
assert builtins.attrNames cfg.services.caddy.virtualHosts == routes;
assert builtins.all (name: builtins.hasAttr name cfg.system.build) destructive;
assert
  cfg.virtualisation.docker.enable == false
  && cfg.virtualisation.podman.enable == false
  && cfg.services.cockpit.enable == false;
assert cfg.my.hatchi.remoteNana == null;
assert lib.versions.major cfg.services.nextcloud.package.version == "33";
assert cfg.services.nextcloud.datadir == "/srv/nextcloud";
assert cfg.my.host.uid == 1000;
assert cfg.users.users.${cfg.my.host.userName}.uid == 1000;
assert builtins.elem hatchiPublicKey
  cfg.users.users.${cfg.my.host.userName}.openssh.authorizedKeys.keys;
assert builtins.elem hatchiPublicKey cfg.users.users.root.openssh.authorizedKeys.keys;
assert cfg.users.groups.users.gid == 100;
assert cfg.zramSwap.enable;
assert cfg.services.fstrim.enable;
assert cfg.services.journald.extraConfig == "SystemMaxUse=2G";
assert cfg.nix.settings.auto-optimise-store;
assert cfg.nix.gc.automatic;
assert cfg.nix.gc.dates == [ "weekly" ];
assert cfg.nix.gc.options == "--delete-older-than 14d";
assert
  builtins.attrNames self.deploy.nodes == [
    "srv-hatchi"
    "srv-nana"
  ];
assert self.deploy.autoRollback && self.deploy.magicRollback;
assert self.deploy.nodes.srv-hatchi.hostname == "srv-hatchi";
assert self.deploy.nodes.srv-hatchi.sshUser == cfg.my.deploy.userName;
assert self.deploy.nodes.srv-nana.sshUser == cfg.my.deploy.userName;
assert builtins.all (node: !node.interactiveSudo) (builtins.attrValues self.deploy.nodes);
assert cfg.users.users.${cfg.my.deploy.userName}.isSystemUser;
assert cfg.users.users.${cfg.my.deploy.userName}.group == cfg.my.deploy.userName;
assert !(builtins.elem "wheel" cfg.users.users.${cfg.my.deploy.userName}.extraGroups);
assert builtins.elem cfg.my.deploy.userName cfg.nix.settings.trusted-users;
assert cfg.users.users.${cfg.my.deploy.userName}.hashedPassword == null;
assert cfg.users.users.${cfg.my.deploy.userName}.password == null;
assert builtins.any (
  rule:
  builtins.elem cfg.my.deploy.userName rule.users
  && builtins.any (
    command: command.command == "ALL" && builtins.elem "NOPASSWD" command.options
  ) rule.commands
) cfg.security.sudo.extraRules;
assert builtins.all (rule: rule.users == [ cfg.my.deploy.userName ]) (
  builtins.filter (
    rule: builtins.any (command: builtins.elem "NOPASSWD" command.options) rule.commands
  ) cfg.security.sudo.extraRules
);
assert self.nixosConfigurations.srv-nana.config.virtualisation.docker.enable;
assert home.home.username == cfg.my.host.userName;
assert home.home.homeDirectory == cfg.my.host.homeDirectory;
assert cfg.users.users.${cfg.my.host.userName}.home == home.home.homeDirectory;
assert pkgs.lib.hasPrefix "/nix/store/" home.home.file.".agents/skills".source;
assert home.home.file.".agents/skills".recursive;
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
assert home.programs.go.enable;
assert home.programs.go.package == null;
assert
  {
    inherit (home.programs.go.env) GOPATH GOBIN GOCACHE;
  } == expectedGoEnv;
assert
  {
    inherit (home.home.sessionVariables) GOPATH GOBIN GOCACHE;
  } == expectedGoEnv;
assert !(home.programs.go.env ? GOMODCACHE);
assert !(home.home.sessionVariables ? GOMODCACHE);
assert home.xdg.localBinInPath;
assert lib.getName cfg.users.users.${cfg.my.host.userName}.shell == "zsh";
assert lib.hasInfix "home-manager" home.home.activationPackage.drvPath;
assert
  cfg.networking.nameservers == [
    "1.1.1.1"
    "9.9.9.9"
  ];
assert
  cfg.services.logind.settings.Login == {
    HandleLidSwitch = "ignore";
    HandleLidSwitchDocked = "ignore";
    HandleLidSwitchExternalPower = "ignore";
    KillUserProcesses = false;
  };
assert
  cfg.systemd.sleep.settings.Sleep == {
    AllowSuspend = "no";
    AllowHibernation = "no";
    AllowHybridSleep = "no";
    AllowSuspendThenHibernate = "no";
  };
assert
  renamedUser.home-manager.users.hatchi-fixture.home.homeDirectory == "/srv/home/hatchi-fixture";
assert renamedUser.users.users.hatchi-fixture.home == "/srv/home/hatchi-fixture";
assert cfg.my.hatchi.onepassword.references.glanceKey == null;
assert privateMachine.my.hatchi.onepassword.references.glanceKey == null;
assert privateMachine.my.hatchi.onepassword.references.grafanaKey == null;
assert lib.all (reference: lib.hasPrefix "op://" reference) (
  builtins.attrValues production.my.hatchi.onepassword.references
);
assert
  withAppSecrets.services.glance.settings.auth.users.daniel.password._secret
  == "/run/hatchi-onepassword/glancePassword";
assert withAppSecrets.my.hatchi.secretService == "hatchi-secret-files.service";
assert builtins.elem "hatchi-secret-files.service"
  withAppSecrets.systemd.services.wpa_supplicant.requires;
assert builtins.elem "hatchi-secret-files.service"
  withAppSecrets.systemd.services.wpa_supplicant.after;
assert builtins.elem "hatchi-secret-files.service"
  withAppSecrets.systemd.services.wpa_supplicant.partOf;
assert cfg.services.nextcloud.config.adminpassFile == null;
assert cfg.services.nextcloud.config.adminuser == null;
assert builtins.elem "nextcloud-admin.service" cfg.systemd.services.nginx.requires;
assert builtins.elem "adminpass:/run/hatchi-onepassword/nextcloudPassword"
  cfg.systemd.services.nextcloud-admin.serviceConfig.LoadCredential;
assert builtins.elem "adminpass:/run/hatchi-onepassword/nextcloudPassword"
  withAppSecrets.systemd.services.nextcloud-admin.serviceConfig.LoadCredential;
assert lib.hasInfix "--password-from-env" cfg.systemd.services.nextcloud-admin.script;
assert withAppSecrets.services.onepassword-secrets.tokenFile == "/run/test-opnix-token";
assert !withAppSecrets.services.onepassword-secrets.systemdIntegration.enable;
assert
  builtins.length (builtins.attrNames withAppSecrets.services.onepassword-secrets.secrets)
  == builtins.length (builtins.attrNames withAppSecrets.my.hatchi.onepassword.references);
assert builtins.all (secret: secret.mode == "0400") (
  builtins.attrValues withAppSecrets.services.onepassword-secrets.secrets
);
assert builtins.all
  (
    name:
    let
      secret = withAppSecrets.services.onepassword-secrets.secrets.${name};
    in
    secret.owner == "grafana" && secret.group == "grafana"
  )
  [
    "grafanaKey"
    "grafanaPassword"
  ];
assert builtins.all
  (name: withAppSecrets.services.onepassword-secrets.secrets.${name}.owner == "root")
  [
    "cloudflare"
    "couchdbAdmin"
    "adguardPasswordHash"
    "qbittorrentPasswordHash"
    "glanceKey"
    "glancePassword"
    "nextcloudPassword"
  ];
assert builtins.all (name: cfg.my.hatchi.onepassword.references.${name} == null) [
  "cloudflare"
  "couchdbAdmin"
  "adguardPasswordHash"
  "qbittorrentPasswordHash"
  "grafanaKey"
];
assert !(withAppSecrets.services.onepassword-secrets.secrets ? adguardPassword);
assert !(withAppSecrets.services.onepassword-secrets.secrets ? qbittorrentPassword);
assert
  withAppSecrets.services.adguardhome.settings.users == [
    {
      name = "daniel";
      password = "@hatchi-adguard-hash@";
    }
  ];
assert
  withAppSecrets.services.qbittorrent.serverConfig.Preferences."WebUI\\Password_PBKDF2"
  == "@hatchi-qbittorrent-hash@";
assert lib.hasInfix "replace-secret" withAppSecrets.systemd.services.hatchi-secret-files.script;
assert !(lib.hasInfix "render-secrets" withAppSecrets.systemd.services.hatchi-secret-files.script);
assert withAppSecrets.systemd.services.hatchi-secret-files.requires == [ "opnix-secrets.service" ];
assert withAppSecrets.systemd.services.hatchi-secret-files.partOf == [ "opnix-secrets.service" ];
assert builtins.all (
  unit:
  builtins.elem "hatchi-secret-files.service" withAppSecrets.systemd.services.${unit}.requires
  && builtins.elem "hatchi-secret-files.service" withAppSecrets.systemd.services.${unit}.after
  && builtins.elem "hatchi-secret-files.service" withAppSecrets.systemd.services.${unit}.partOf
) withAppSecrets.my.hatchi.stateUnits;
assert builtins.all
  (
    name:
    builtins.any (
      check:
      !check.assertion
      &&
        check.message
        == "Hatchi 1Password reference ${name} must be provisioned before enabling this provider"
    ) missingAppKeys.assertions
  )
  [
    "glanceKey"
    "grafanaKey"
    "cloudflare"
    "couchdbAdmin"
    "adguardPasswordHash"
    "qbittorrentPasswordHash"
  ];
assert builtins.any (
  check:
  check.message == "Hatchi's 1Password token must be provisioned outside the Nix store"
  && !check.assertion
) storeToken.assertions;
assert !cfg.services.onepassword-secrets.enable;
assert !(cfg.systemd.services ? opnix-secrets);
assert !disabledOnePassword.services.onepassword-secrets.enable;
assert !(disabledOnePassword.systemd.services ? opnix-secrets);
assert withConfigFile.services.onepassword-secrets.enable;
assert withOnePassword.services.onepassword-secrets.enable;
assert withOnePassword.services.onepassword-secrets.users == [ ];
assert withOnePassword.services.onepassword-secrets.secrets.integrationProbe.mode == "0600";
assert withOnePassword.services.onepassword-secrets.secrets.integrationProbe.owner == "root";
assert !(withOnePassword.systemd.services ? opnix-secrets-poll);
assert !(withoutIntegration.systemd.services ? opnix-secrets-restart);
assert !(withoutIntegration.systemd.services ? opnix-secrets-poll);
assert builtins.elem "opnix-secrets.service" withOnePassword.systemd.services.radarr.after;
assert builtins.elem "opnix-secrets.service" withOnePassword.systemd.services.radarr.wants;
assert
  withOnePassword.services.onepassword-secrets.secretPaths.integrationProbe
  == "/var/lib/opnix/secrets/integrationProbe";
pkgs.runCommand "srv-hatchi-policy"
  {
    nativeBuildInputs = [
      pkgs.bash
      pkgs.git
      pkgs.coreutils
      pkgs.diffutils
      pkgs.gnugrep
      pkgs.findutils
      pkgs.getconf
      self.packages.${pkgs.stdenv.hostPlatform.system}.opnix
    ];
    ROOT = self;
    NIX_STUB = nixStub;
    SSH_STUB = sshStub;
  }
  ''
    bash ${./policy.sh}
    touch $out
  ''
