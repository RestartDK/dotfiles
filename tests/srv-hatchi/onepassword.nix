{
  pkgs,
  self,
  inputs,
}:
let
  fields = {
    cloudflare = "cloudflare";
    adguardPasswordHash = "adguard-password";
    couchdbAdmin = "couchdb-admin";
    glanceKey = "glance-key";
    glancePassword = "glance-password";
    grafanaKey = "grafana-key";
    grafanaPassword = "grafana-password";
    nextcloudPassword = "nextcloud-admin";
    qbittorrentPasswordHash = "qbittorrent-password";
  };
in
pkgs.testers.runNixOSTest {
  name = "srv-hatchi-onepassword";
  globalTimeout = 1200;
  node.specialArgs = { inherit inputs self; };
  nodes.hatchi = { config, lib, ... }: {
    imports = [ ./onepassword-machine.nix ];
    virtualisation = {
      memorySize = 4608;
      cores = 4;
      diskSize = 16384;
      fileSystems."/srv/media" = {
        device = "tmpfs";
        fsType = "tmpfs";
        options = [
          "size=64M"
          "mode=0755"
        ];
      };
    };
    assertions = [
      {
        assertion = config.fileSystems."/srv/media".fsType == "tmpfs";
        message = "The credential-file VM must mount disposable media";
      }
    ];
    my.hatchi.onepassword = {
      tokenFile = "/run/test-opnix-token";
      references = lib.mapAttrs (name: _: "op://fixture/credentials/${name}") fields;
    };
    system.activationScripts.test-token.text = ''
      install -m400 ${pkgs.writeText "fixture-token" "synthetic-token"} /run/test-opnix-token
    '';
    systemd.services.opnix-secrets.serviceConfig.ExecStart = lib.mkForce (
      pkgs.writeShellScript "opnix-fixture" ''
        set -eu
        umask 077
        export SOPS_AGE_KEY_FILE=${./fixtures/age-key.txt}
        mkdir -p /run/hatchi-onepassword
        ${lib.concatStringsSep "\n" (
          lib.mapAttrsToList (name: field: ''
            ${pkgs.sops}/bin/sops decrypt --extract '${builtins.toJSON [ field ]}' ${./fixtures/synthetic-secrets.sops.yaml} > ${
              config.services.onepassword-secrets.secretPaths.${name}
            }
            chmod 400 ${config.services.onepassword-secrets.secretPaths.${name}}
          '') fields
        )}
        chown grafana:grafana /run/hatchi-onepassword/grafanaKey /run/hatchi-onepassword/grafanaPassword
        if test -e /run/empty-adguard-hash; then
          truncate -s0 /run/hatchi-onepassword/adguardPasswordHash
        fi
      ''
    );
    environment.systemPackages = [
      pkgs.curl
      pkgs.jq
    ];
  };
  testScript = ''
    import json

    hatchi.start(allow_reboot=True)
    start_all()
    units = ["hatchi-secret-files", "adguardhome", "grafana", "glance", "couchdb", "qbittorrent", "nextcloud-admin", "nginx"]

    def check_logins():
        for unit in units:
            hatchi.wait_for_unit(unit + ".service", timeout=600)
        for port in [3000, 3001, 8081, 5984, 8080, 11000]:
            hatchi.wait_for_open_port(port, "127.0.0.1", timeout=600)
        hatchi.wait_until_succeeds("curl -fsS http://127.0.0.1:3001/api/health | jq -e '.database == \"ok\"'")
        hatchi.succeed("curl -fsS -u daniel:fixture-password http://127.0.0.1:3000/control/status | jq -e '.dns_addresses'")
        hatchi.succeed("curl -fsS -u daniel:fixture-password http://127.0.0.1:3001/api/user | jq -e '.login == \"daniel\"'")
        hatchi.succeed("curl -fsS -u daniel:fixture-password http://127.0.0.1:5984/_session | jq -e '.userCtx.roles | index(\"_admin\")'")
        hatchi.succeed("curl -fsS -D /tmp/glance-headers -o /dev/null -H 'Content-Type: application/json' --data '{\"username\":\"daniel\",\"password\":\"fixture-password\"}' http://127.0.0.1:8081/api/authenticate; grep -qi '^set-cookie:' /tmp/glance-headers")
        hatchi.succeed("curl -fsS -c /tmp/qb-cookies -H 'Host: qbittorrent.chateauducipieres.com' -H 'Origin: http://qbittorrent.chateauducipieres.com' --data 'username=daniel&password=fixture-password' http://127.0.0.1:8080/api/v2/auth/login")
        hatchi.succeed("curl -fsS -b /tmp/qb-cookies -H 'Host: qbittorrent.chateauducipieres.com' http://127.0.0.1:8080/api/v2/app/version | grep '^v'")
        assert hatchi.succeed("curl -fsS -o /dev/null -w '%{http_code}' -u daniel:fixture-password -H 'Host: nextcloud.chateauducipieres.com' -H 'X-Forwarded-Proto: https' -H 'Depth: 0' -X PROPFIND http://127.0.0.1:11000/remote.php/dav/files/daniel/").strip() == "207"
        assert "admin" in json.loads(hatchi.succeed("nextcloud-occ user:info daniel --output=json"))["groups"]

    hatchi.wait_for_unit("srv-media.mount")
    hatchi.succeed("mountpoint -q /srv/media")
    check_logins()
    for name in ${builtins.toJSON (builtins.attrNames fields)}:
        owner = "grafana:grafana" if name.startswith("grafana") else "root:root"
        hatchi.succeed(f"test $(stat -c %U:%G:%a /run/hatchi-onepassword/{name}) = {owner}:400")
        hatchi.fail(f"runuser -u nobody -- cat /run/hatchi-onepassword/{name}")
    for name in ["AdGuardHome.yaml", "qBittorrent.conf"]:
        hatchi.succeed(f"test $(stat -c %U:%G:%a /run/hatchi-secrets/{name}) = root:root:400")
        hatchi.fail(f"grep -q '@hatchi-' /run/hatchi-secrets/{name}")
        hatchi.fail(f"runuser -u nobody -- cat /run/hatchi-secrets/{name}")
    invocations = {unit: hatchi.succeed(f"systemctl show {unit} -p InvocationID --value").strip() for unit in units}
    hatchi.succeed("systemctl restart opnix-secrets.service")
    check_logins()
    for unit in units:
        assert hatchi.succeed(f"systemctl show {unit} -p InvocationID --value").strip() != invocations[unit]

    hatchi.succeed("mv /run/test-opnix-token /run/saved-token; systemctl reset-failed opnix-secrets.service")
    hatchi.fail("systemctl restart opnix-secrets.service")
    for unit in units:
        hatchi.fail(f"systemctl is-active --quiet {unit}")
    hatchi.succeed("mv /run/saved-token /run/test-opnix-token; touch /run/empty-adguard-hash; systemctl reset-failed opnix-secrets.service")
    hatchi.fail("systemctl restart opnix-secrets.service")
    for unit in units:
        hatchi.fail(f"systemctl is-active --quiet {unit}")
    hatchi.reboot()
    check_logins()
  '';
}
