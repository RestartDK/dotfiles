{
  pkgs,
  inputs,
  self,
}:
let
  inherit (pkgs) lib;
  home =
    profile: deployments:
    (inputs.home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      extraSpecialArgs.dotfilesInputs = inputs // {
        inherit self;
      };
      modules = [
        ../modules/home/live-config-options.nix
        ../modules/home/herdr-durable.nix
        {
          my.ai.profile = profile;
          my.ai.openrouterKeyFile = "/task-only/percent%tree and space/key";
          home = {
            username = "deployment-test";
            homeDirectory = "/home/deployment-test";
            stateVersion = "26.05";
          };
          xdg.enable = true;
          services.herdrDurable.deployments = deployments;
        }
      ];
    }).config;
  registry = {
    work.hostConfigFile = "/home/deployment-test/.config/herdr-durable/work/host.json";
    personal.hostConfigFile = "/home/deployment-test/.config/herdr-durable/personal/host.json";
  };
  configured = home "personal" registry;
  workProfile = home "work" registry;
  units = configured.systemd.user.services;
  services = map (name: units.${name}.Service) (builtins.attrNames units);
  unitSources = map (name: configured.xdg.configFile."systemd/user/${name}.service".source) (
    builtins.attrNames units
  );
  environment =
    service:
    builtins.listToAttrs (
      map (
        encoded:
        let
          assignment = builtins.fromJSON (builtins.unsafeDiscardStringContext encoded);
          matched = builtins.match "([^=]+)=(.*)" assignment;
        in
        lib.nameValuePair (builtins.elemAt matched 0) (builtins.elemAt matched 1)
      ) service.Environment
    );
  environments = map environment services;
  valid = value: builtins.all (assertion: assertion.assertion) value.assertions;
  rejected =
    value:
    let
      checked = builtins.tryEval (builtins.deepSeq value.assertions (valid value));
    in
    !checked.success || !checked.value;
  defaults = map (profile: home profile { }) [
    "work"
    "personal"
  ];
  single = home "personal" { work = { }; };
  invalidNames = home "personal" { "bad/name" = { }; };
  duplicate = home "personal" {
    a.hostConfigFile = registry.work.hostConfigFile;
    b.hostConfigFile = registry.work.hostConfigFile;
  };
  storeConfig = home "personal" { a.hostConfigFile = "/nix/store/not-a-private-config/host.json"; };
  tooMany = home "personal" (
    builtins.listToAttrs (builtins.genList (i: lib.nameValuePair "instance-${toString i}" { }) 17)
  );
  evidence = {
    defaultServices = map (value: builtins.attrNames value.systemd.user.services) defaults;
    configuredServices = builtins.attrNames units;
    inherit environments;
    servicePolicy = map (
      service:
      builtins.removeAttrs service [
        "Environment"
        "ExecStart"
      ]
    ) services;
    billingProfileDoesNotSelectDeployment = units == workProfile.systemd.user.services;
  };
in
assert builtins.all valid defaults;
assert builtins.all (value: value.systemd.user.services == { }) defaults;
assert valid configured;
assert rejected invalidNames && rejected duplicate && rejected storeConfig && rejected tooMany;
assert
  builtins.attrNames units == [
    "herdr-durable-personal"
    "herdr-durable-work"
  ];
assert units == workProfile.systemd.user.services;
assert
  (environment single.systemd.user.services.herdr-durable-work.Service).DSTACK_PROTECTED_PATHS
  == (environment units.herdr-durable-work.Service).DSTACK_PROTECTED_PATHS;
assert builtins.all (
  service:
  service.Restart == "no"
  && service.UMask == "0077"
  && service.NoNewPrivileges
  && builtins.elem "HERDR_ENV" service.UnsetEnvironment
) services;
assert builtins.all (
  env:
  !(env ? XDG_RUNTIME_DIR)
  && env.DSTACK_HOST_MODE == "deployment"
  && env.DSTACK_STATE_DIR == "/home/deployment-test/.local/state/dstack"
) environments;
assert builtins.length (lib.unique (map (env: env.HERDR_SOCKET_PATH) environments)) == 2;
assert builtins.length (lib.unique (map (env: env.HERDR_CLIENT_SOCKET_PATH) environments)) == 2;
assert builtins.length (lib.unique (map (env: env.HERDR_DURABLE_HOST_CONFIG) environments)) == 2;
assert builtins.length (lib.unique (map (env: env.XDG_STATE_HOME) environments)) == 2;
assert builtins.length (lib.unique (map (env: env.XDG_CONFIG_HOME) environments)) == 2;
assert builtins.all (
  env:
  builtins.elem "/home/deployment-test/.config/herdr-durable" (
    builtins.fromJSON env.DSTACK_PROTECTED_PATHS
  )
  && builtins.elem "/home/deployment-test/.local/state/herdr-durable" (
    builtins.fromJSON env.DSTACK_PROTECTED_PATHS
  )
) environments;
pkgs.runCommand "herdr-deployment-contracts"
  {
    nativeBuildInputs = [ pkgs.systemd ];
    passthru = { inherit evidence; };
  }
  ''
    set -o pipefail
    mkdir -p "$out/units" "$TMPDIR/runtime" "$TMPDIR/home"
    chmod 0700 "$TMPDIR/runtime"
    export XDG_RUNTIME_DIR="$TMPDIR/runtime" HOME="$TMPDIR/home"
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$TMPDIR/unreachable"
    cp ${lib.concatMapStringsSep " " lib.escapeShellArg unitSources} "$out/units/"
    SYSTEMD_LOG_LEVEL=debug systemd-analyze --user --man=no --recursive-errors=no \
      verify "$out/units/"*.service 2>&1 | tee "$out/verify.log"
    grep -F '/task-only/percent%tree and space' "$out/verify.log"
    grep -F "$XDG_RUNTIME_DIR/herdr-durable-personal/api.sock" "$out/verify.log"
    grep -F "$XDG_RUNTIME_DIR/herdr-durable-work/client.sock" "$out/verify.log"
    cp ${pkgs.writeText "herdr-deployment-evidence.json" (builtins.toJSON evidence)} "$out/evidence.json"
  ''
