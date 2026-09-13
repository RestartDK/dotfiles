{
  pkgs,
  self,
  inputs,
}:
pkgs.testers.runNixOSTest {
  name = "srv-hatchi-services";
  globalTimeout = 1800;
  node.specialArgs = { inherit inputs; };
  nodes = {
    hatchi = { config, lib, ... }: {
      imports = [ self.nixosModules.srv-hatchi ];
      networking.hostName = "srv-hatchi";
      virtualisation = {
        memorySize = 4608;
        cores = 4;
        diskSize = 16384;
        vlans = [
          1
          2
        ];
      };
      networking.interfaces = {
        eth1 = {
          ipv4.addresses = lib.mkForce [
            {
              address = "192.168.1.10";
              prefixLength = 24;
            }
          ];
          ipv6.addresses = lib.mkForce [
            {
              address = "fd00:1::10";
              prefixLength = 64;
            }
          ];
        };
        eth2 = {
          ipv4.addresses = lib.mkForce [
            {
              address = "192.168.2.10";
              prefixLength = 24;
            }
          ];
          ipv6.addresses = lib.mkForce [
            {
              address = "fd00:2::10";
              prefixLength = 64;
            }
          ];
        };
      };
      virtualisation.fileSystems."/srv/media" = {
        device = "/var/lib/hatchi-test-media.img";
        fsType = "ext4";
        options = [
          "loop"
          "nofail"
        ];
      };
      assertions = [
        {
          assertion = config.fileSystems."/srv/media".device == "/var/lib/hatchi-test-media.img";
          message = "The Hatchi service VM must use its disposable media image";
        }
      ];
      my.hatchi = {
        network = {
          dnsAnswer = "192.168.1.10";
          clientNetworks = [
            "192.168.1.20/32"
            "fd00:1::20/128"
          ];
          adminNetworks = [
            "192.168.1.50/32"
            "fd00:1::50/128"
          ];
          upstreamDNS = [ "192.168.1.40:53" ];
        };
        remoteNana = {
          ollama = "192.168.1.40:8000";
          opencode = "192.168.1.40:8001";
          nodeExporter = "192.168.1.40:9100";
          glanceAgent = "192.168.1.40:8002";
        };
      };
      sops = {
        defaultSopsFile = lib.mkForce "/run/hatchi-test-secrets.yaml";
        validateSopsFiles = lib.mkForce false;
        age.keyFile = lib.mkForce "/run/hatchi-test-age-key";
      };
      system.activationScripts.hatchi-test-key.text = ''
        install -m600 ${./fixtures/age-key.txt} /run/hatchi-test-age-key
        install -m600 ${./fixtures/synthetic-secrets.sops.yaml} /run/hatchi-test-secrets.yaml
      '';
      environment.etc."hatchi-test-sops-manifest.json".source = config.system.build.sops-nix-manifest;
      security.acme.certs = lib.mkForce { };
      services.caddy.virtualHosts =
        lib.genAttrs
          (builtins.attrNames self.nixosConfigurations.srv-hatchi.config.services.caddy.virtualHosts)
          (_: {
            useACMEHost = lib.mkForce null;
            extraConfig = lib.mkBefore "tls internal";
          });
      services.caddy.globalConfig = "skip_install_trust";
      environment.etc."hatchi-production.Caddyfile".source =
        self.nixosConfigurations.srv-hatchi.config.services.caddy.configFile;
      environment.systemPackages = [
        pkgs.dig
        pkgs.openssl
        pkgs.libxml2
        pkgs.util-linux
        pkgs.e2fsprogs
        pkgs.prometheus.cli
        pkgs.caddy
        pkgs.sops
        config.sops.package
      ];
    };
    client = { lib, ... }: {
      virtualisation.memorySize = 256;
      networking.interfaces.eth1 = {
        ipv4.addresses = lib.mkForce [
          {
            address = "192.168.1.20";
            prefixLength = 24;
          }
        ];
        ipv6.addresses = lib.mkForce [
          {
            address = "fd00:1::20";
            prefixLength = 64;
          }
        ];
      };
      environment.systemPackages = [
        pkgs.curl
        pkgs.dig
        pkgs.netcat-openbsd
      ];
    };
    admin = { lib, ... }: {
      virtualisation.memorySize = 256;
      networking.interfaces.eth1 = {
        ipv4.addresses = lib.mkForce [
          {
            address = "192.168.1.50";
            prefixLength = 24;
          }
        ];
        ipv6.addresses = lib.mkForce [
          {
            address = "fd00:1::50";
            prefixLength = 64;
          }
        ];
      };
      environment.systemPackages = [
        pkgs.curl
        pkgs.dig
        pkgs.netcat-openbsd
        pkgs.openssh
      ];
    };
    outsider = { lib, ... }: {
      virtualisation = {
        memorySize = 256;
        vlans = [ 2 ];
      };
      networking.interfaces.eth1 = {
        ipv4.addresses = lib.mkForce [
          {
            address = "192.168.2.30";
            prefixLength = 24;
          }
        ];
        ipv6.addresses = lib.mkForce [
          {
            address = "fd00:2::30";
            prefixLength = 64;
          }
        ];
      };
      environment.systemPackages = [
        pkgs.curl
        pkgs.dig
        pkgs.netcat-openbsd
      ];
    };
    nana = { lib, ... }: {
      virtualisation.memorySize = 384;
      networking.interfaces.eth1.ipv4.addresses = lib.mkForce [
        {
          address = "192.168.1.40";
          prefixLength = 24;
        }
      ];
      networking.firewall.allowedTCPPorts = [
        53
        8000
        8001
        8002
        9100
      ];
      networking.firewall.allowedUDPPorts = [ 53 ];
      services.prometheus.exporters.node = {
        enable = true;
        listenAddress = "0.0.0.0";
      };
      services.dnsmasq = {
        enable = true;
        settings = {
          no-resolv = true;
          address = [ "/fixture-upstream.test/192.0.2.99" ];
          local = [ "/chateauducipieres.com/" ];
        };
      };
      services.nginx = {
        enable = true;
        virtualHosts = builtins.listToAttrs (
          map
            (fixture: {
              inherit (fixture) name;
              value = {
                listen = [
                  {
                    addr = "0.0.0.0";
                    inherit (fixture) port;
                  }
                ];
                locations."/".extraConfig = ''
                  default_type application/json;
                  return 200 '${builtins.toJSON { marker = fixture.name; }}';
                '';
              };
            })
            [
              {
                name = "fixture-ollama";
                port = 8000;
              }
              {
                name = "fixture-opencode";
                port = 8001;
              }
              {
                name = "fixture-glance-agent";
                port = 8002;
              }
            ]
        );
      };
    };
  };
  testScript = ''
    import base64
    import hashlib
    import ipaddress
    import json
    import shlex

    hatchi.start(allow_reboot=True)
    start_all()
    for machine in [hatchi, client, admin, outsider, nana]:
        machine.wait_for_unit("multi-user.target")
    nana.wait_for_unit("nginx.service")
    for port in [8000, 8001, 8002, 9100]:
        nana.wait_for_open_port(port)
    hatchi.wait_for_unit("sops-install-secrets.service")
    hatchi.fail("mountpoint -q /srv/media")
    hatchi.fail("systemctl start nextcloud-setup.service")
    hatchi.fail("systemctl start hatchi-media-directories.service")
    hatchi.fail("test -s /var/lib/nextcloud/config/config.php")
    hatchi.fail("find /var/lib/postgresql -name PG_VERSION -print 2>/dev/null | grep .")
    for directory in ["movies", "tvshows", "manga", "downloads"]:
        hatchi.fail(f"test -e /srv/media/{directory}")

    hatchi.succeed("truncate -s 128M /var/lib/hatchi-test-media.img; mkfs.ext4 -F -L hatchi-media /var/lib/hatchi-test-media.img")
    hatchi.succeed("systemctl reset-failed; systemctl start srv-media.mount")
    hatchi.wait_for_unit("srv-media.mount")
    assert hatchi.succeed("findmnt -n -o LABEL,FSTYPE --mountpoint /srv/media").split() == ["hatchi-media", "ext4"]
    units = ["adguardhome", "caddy", "glance", "komga", "suwayomi-server", "jellyfin", "seerr", "radarr", "sonarr", "prowlarr", "qbittorrent", "nextcloud-admin", "nextcloud-setup", "nextcloud-cron", "nextcloud-update-db", "phpfpm-nextcloud", "nginx", "postgresql", "postgresql-setup", "redis-nextcloud", "couchdb", "prometheus", "grafana"]
    hatchi.succeed("systemctl reset-failed; systemctl start " + " ".join(unit + ".service" for unit in units if unit not in ["nextcloud-cron", "nextcloud-update-db"]))
    for unit in units:
        if unit in ["nextcloud-setup", "postgresql-setup", "nextcloud-update-db", "nextcloud-cron"]:
            continue
        hatchi.wait_for_unit(unit + ".service", timeout=600)
    hatchi.wait_for_unit("prometheus-node-exporter.service")
    hatchi.succeed("test $(stat -c %U:%G:%a /var/lib/sonarr) = sonarr:media:700")
    for port in [53, 80, 443, 2019, 3000, 8081, 25600, 4567, 8096, 7878, 8989, 9696, 8080, 5055, 11000, 5984, 3001, 9090, 9100]:
        hatchi.wait_for_open_port(port, "127.0.0.1", timeout=600)
    hatchi.succeed("test $(systemctl show nextcloud-setup.service -p ExecMainStatus --value) = 0")

    inventory = json.loads(r'${builtins.toJSON (builtins.fromJSON (builtins.readFile ./inventory.json))}')
    assert len(inventory) == 17
    assert len([entry for entry in inventory if entry["unit"] is not None]) == 16
    assert len({entry["source"] for entry in inventory}) == 17
    assert [entry["source"] for entry in inventory if entry["unit"] is None] == ["portainer"]
    assert "open-webui" not in {entry["source"] for entry in inventory}
    names = [entry["route"] for entry in inventory if entry["route"] is not None] + ["ollama", "opencode"]
    for entry in inventory:
        if entry["unit"] is not None:
            assert hatchi.succeed(f"systemctl show {entry['unit']} -p LoadState --value").strip() == "loaded"
    checked_routes = set()

    domain = "chateauducipieres.com"
    for name in names:
        for protocol in ["", "+tcp"]:
            answer = client.succeed(f"dig @192.168.1.10 {name}.{domain} A +short {protocol}").strip()
            assert answer == "192.168.1.10", (name, protocol, answer)
    assert client.succeed("dig @192.168.1.10 fixture-upstream.test A +short").strip() == "192.0.2.99"
    for name in ["portainer", "admin", "jellyseerr", "open-webui"]:
        for protocol in ["", "+tcp"]:
            assert client.succeed(f"dig @192.168.1.10 {name}.{domain} A +short {protocol}").strip() == ""
        client.fail(f"curl --noproxy '*' --connect-timeout 3 -ksS --resolve {name}.{domain}:443:192.168.1.10 https://{name}.{domain}/")


    def curl(name, path="/", options=""):
        return f"curl --noproxy '*' --connect-timeout 5 --max-time 20 -ksS --resolve {name}.{domain}:443:192.168.1.10 -H 'Referer: https://{name}.{domain}/' {options} https://{name}.{domain}{path}"


    def response(name, path="/", options=""):
        checked_routes.add(name)
        return client.succeed(curl(name, path, options))


    for name in names:
        assert client.succeed(f"curl --noproxy '*' -sS -o /dev/null -w '%{{http_code}}' --resolve {name}.{domain}:80:192.168.1.10 http://{name}.{domain}/").strip() == "308"
    client.wait_until_succeeds(curl("jellyfin", "/health", "-f") + " | grep -q Healthy", timeout=600)
    assert response("jellyfin", "/health", "-f").strip() == "Healthy"
    assert "<title>Login</title>" in response("adguard", "/login.html", "-f")
    assert "<title>AdGuard Home</title>" in response("adguard", "/", "-f -u daniel:fixture-password")
    assert "dns_addresses" in json.loads(response("adguard", "/control/status", "-f -u daniel:fixture-password"))
    assert "Glance" in response("dashboard", "/", "-L")
    assert "Komga" in response("komga", "/", "-f -L")
    assert response("komga", "/api/v1/libraries", "-o /dev/null -w '%{http_code}'").strip() == "401"
    assert response("suwayomi", "/api/v1/category", "-o /dev/null -w '%{http_code}'").strip() == "200"
    assert isinstance(json.loads(response("suwayomi", "/api/v1/category", "-f")), list)
    for name, port, state in [("radarr", 7878, "/var/lib/radarr"), ("sonarr", 8989, "/var/lib/sonarr"), ("prowlarr", 9696, "/var/lib/prowlarr")]:
        api_key = hatchi.succeed(f"xmllint --xpath 'string(/Config/ApiKey)' {state}/config.xml").strip()
        api = "/api/v1/system/status" if name == "prowlarr" else "/api/v3/system/status"
        direct = json.loads(hatchi.succeed(f"curl -fsS -H 'X-Api-Key: {api_key}' http://127.0.0.1:{port}{api}"))
        proxied = json.loads(response(name, api, f"-f -H 'X-Api-Key: {api_key}'"))
        assert direct["appName"].lower() == name, direct
        assert proxied["appName"] == direct["appName"], proxied
        assert proxied["instanceName"] == direct["instanceName"], proxied
    assert response("qbittorrent", "/api/v2/auth/login", "-f -c /tmp/qb-cookies -o /dev/null -w '%{http_code}' --data 'username=daniel&password=fixture-password'").strip() == "204"
    assert response("qbittorrent", "/api/v2/app/version", "-f -b /tmp/qb-cookies").strip() == "v${self.nixosConfigurations.srv-hatchi.config.services.qbittorrent.package.version}"
    assert "version" in json.loads(response("seerr", "/api/v1/status"))
    assert json.loads(response("couchdb", "/_up", "-f -u daniel:fixture-password"))["status"] == "ok"
    for name in ["ollama", "opencode"]:
        assert json.loads(response(name, "/api/version", "-f"))["marker"] == f"fixture-{name}"
    assert json.loads(response("grafana", "/api/health", "-f"))["database"] == "ok"
    assert response("grafana", "/api/datasources", "-o /dev/null -w '%{http_code}'").strip() == "401"
    datasources = json.loads(response("grafana", "/api/datasources", "-f -u daniel:fixture-password"))
    assert len(datasources) == 1 and datasources[0]["type"] == "prometheus"

    for address in ["192.168.1.10", "fd00:1::10"]:
        for port in [53, 80, 443]:
            client.succeed(f"nc -z -w 2 {address} {port}")
        for port in [22, 2019, 4369, 5986, 9101, 3000, 8081, 25600, 4567, 8096, 7878, 8989, 9696, 8080, 5055, 11000, 5984, 3001, 9090, 9100, 5432, 6379, 6881]:
            client.fail(f"nc -z -w 1 {address} {port}")
    for address in ["192.168.1.10", "fd00:1::10"]:
        admin.succeed(f"ssh-keyscan -T 3 {address} 2>/dev/null | grep -q ssh-ed25519")
        for port in [53, 80, 443, 2019, 3000, 8081, 25600, 4567, 8096, 7878, 8989, 9696, 8080, 5055, 11000, 5984, 3001, 9090, 9100, 5432, 6379]:
            admin.fail(f"nc -z -w 1 {address} {port}")
        admin.fail(f"dig @{address} dashboard.{domain} +time=1 +tries=1")
    for address in ["192.168.2.10", "fd00:2::10"]:
        for port in [22, 53, 80, 443, 3000, 8080, 9100, 5432, 6379]:
            outsider.fail(f"nc -z -w 1 {address} {port}")
        outsider.fail(f"dig @{address} dashboard.{domain} +time=1 +tries=1")
    client.succeed(f"dig @fd00:1::10 dashboard.{domain} +short | grep -Fx 192.168.1.10")
    listeners = [line.split()[3].rsplit(":", 1) for line in hatchi.succeed("ss -H -ltn").splitlines()]
    for port in [3000, 8081, 25600, 4567, 7878, 8989, 9696, 8080, 11000, 5984, 3001, 9090, 9100]:
        addresses = [host.strip("[]") for host, number in listeners if number == str(port)]
        assert addresses, (port, listeners)
        for host in addresses:
            address = ipaddress.ip_address(host)
            if isinstance(address, ipaddress.IPv6Address):
                address = address.ipv4_mapped or address
            assert address.is_loopback, (port, host)
    assert "tailscale0" not in hatchi.succeed("nft list ruleset")

    for unit in ["docker.service", "docker.socket", "podman.service", "podman.socket", "portainer.service", "cockpit.service", "cockpit.socket", "nextcloud-aio-mastercontainer.service", "jellyseerr.service", "open-webui.service"]:
        assert hatchi.succeed(f"systemctl show {unit} -p LoadState --value").strip() == "not-found"
    hatchi.fail("test -S /var/run/docker.sock")

    hatchi.wait_until_succeeds("curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=up' | jq -e '.data.result | length == 3 and all(.[]; .value[1] == \"1\")'", timeout=120)
    metrics = json.loads(hatchi.succeed("curl -fsS 'http://127.0.0.1:9090/api/v1/query?query=node_uname_info'"))["data"]["result"]
    assert {metric["metric"]["job"]: metric["metric"]["nodename"] for metric in metrics} == {"hatchi-node": "srv-hatchi", "srv-nana-node": "nana"}
    assert json.loads(hatchi.succeed("curl -fsS http://192.168.1.40:8002/"))["marker"] == "fixture-glance-agent"
    query = json.loads(response("grafana", f"/api/datasources/proxy/uid/{datasources[0]['uid']}/api/v1/query?query=up", "-f -u daniel:fixture-password"))
    assert len(query["data"]["result"]) == 3


    def nextcloud_health():
        status = json.loads(response("nextcloud", "/status.php", "-f"))
        assert status["installed"] and not status["maintenance"] and not status["needsDbUpgrade"], status
        local = json.loads(hatchi.succeed("nextcloud-occ status --output=json"))
        assert local["installed"] and not local["maintenance"] and not local["needsDbUpgrade"], local


    nextcloud_health()
    assert set(names) == checked_routes, (set(names), checked_routes)
    client.succeed("printf 'native-nextcloud-persistence' > /tmp/proof.txt")
    client.succeed(curl("nextcloud", "/remote.php/dav/files/daniel/proof.txt", "-f -u daniel:fixture-password -T /tmp/proof.txt"))
    assert response("nextcloud", "/remote.php/dav/files/daniel/proof.txt", "-f -u daniel:fixture-password") == "native-nextcloud-persistence"
    hatchi.succeed("systemctl start nextcloud-cron.service")
    hatchi.wait_until_succeeds("test $(systemctl show nextcloud-cron.service -p ActiveState --value) = inactive")
    hatchi.succeed("test $(systemctl show nextcloud-cron.service -p ExecMainStatus --value) = 0")

    for user, path in [("radarr", "movies"), ("sonarr", "tvshows"), ("qbittorrent", "downloads"), ("suwayomi", "manga")]:
        hatchi.succeed(f"runuser -u {user} -- touch /srv/media/{path}/permission-proof")
    for unit, path in [("jellyfin", "movies"), ("komga", "manga")]:
        pid = hatchi.succeed(f"systemctl show {unit} -p MainPID --value").strip()
        hatchi.fail(f"nsenter -t {pid} -m -- touch /srv/media/{path}/forbidden")
    hatchi.fail("runuser -u nobody -- cat /run/secrets/nextcloud-admin")
    for state in ["/run/couchdb/local.ini", "/var/lib/qBittorrent/qBittorrent/config/qBittorrent.conf", "/var/lib/AdGuardHome/AdGuardHome.yaml", "/run/secrets/rendered/AdGuardHome.yaml", "/run/secrets/rendered/qBittorrent.conf"]:
        hatchi.fail(f"runuser -u radarr -- cat {state}")
    for name in ["AdGuardHome.yaml", "qBittorrent.conf"]:
        hatchi.succeed(f"test $(stat -Lc %U:%G:%a /run/secrets/rendered/{name}) = root:root:400")
    hatchi.succeed("install -d -m700 /var/lib/acme/chateauducipieres.com")
    hatchi.succeed("openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=*.chateauducipieres.com' -keyout /var/lib/acme/chateauducipieres.com/key.pem -out /var/lib/acme/chateauducipieres.com/cert.pem 2>/dev/null")
    hatchi.succeed("caddy validate --config /etc/hatchi-production.Caddyfile --adapter caddyfile")
    hatchi.succeed("caddy validate --config /etc/caddy/caddy_config --adapter caddyfile")
    hatchi.succeed("promtool check config /etc/prometheus/prometheus.yaml")

    qb_config = "/var/lib/qBittorrent/qBittorrent/config/qBittorrent.conf"
    declared_ratio = json.loads(response("qbittorrent", "/api/v2/app/preferences", "-f -b /tmp/qb-cookies"))["max_ratio"]
    torrent_info = b"d6:lengthi7e4:name12:fixture.data12:piece lengthi16384e6:pieces20:" + hashlib.sha1(b"fixture").digest() + b"e"
    torrent_hash = hashlib.sha1(torrent_info).hexdigest()
    torrent_data = base64.b64encode(b"d4:info" + torrent_info + b"e").decode()
    client.succeed(f"printf %s {torrent_data} | base64 --decode > /tmp/fixture.torrent")
    response("qbittorrent", "/api/v2/torrents/add", "-f -b /tmp/qb-cookies -F torrents=@/tmp/fixture.torrent -F stopped=true")


    def assert_torrent_present():
        path = f"/api/v2/torrents/info?hashes={torrent_hash}"
        client.wait_until_succeeds(curl("qbittorrent", path, "-f -b /tmp/qb-cookies") + f" | grep -F {torrent_hash}")
        assert len(json.loads(response("qbittorrent", path, "-f -b /tmp/qb-cookies"))) == 1


    assert_torrent_present()
    hatchi.succeed("systemctl stop qbittorrent")
    hatchi.succeed(f"printf '\\n[MigrationFixture]\\nRetained=restored-setting\\n' >> {qb_config}")
    hatchi.succeed("systemctl start qbittorrent")
    client.wait_until_succeeds(curl("qbittorrent", "/api/v2/auth/login", "-f -o /dev/null -w '%{http_code}' --data 'username=daniel&password=fixture-password'") + " | grep -Fx 204")
    response("qbittorrent", "/api/v2/auth/login", "-c /tmp/qb-cookies --data 'username=daniel&password=fixture-password'")
    for iteration in range(2):
        client.succeed(curl("qbittorrent", "/api/v2/app/setPreferences", "-f -b /tmp/qb-cookies --data-urlencode 'json={\"max_ratio\":3.25}'"))
        assert json.loads(response("qbittorrent", "/api/v2/app/preferences", "-f -b /tmp/qb-cookies"))["max_ratio"] == 3.25
        response("adguard", "/control/filtering/config", "-f -u daniel:fixture-password -H 'Content-Type: application/json' --data '{\"enabled\":false,\"interval\":24}'")
        assert not json.loads(response("adguard", "/control/filtering/status", "-f -u daniel:fixture-password"))["enabled"]
        hatchi.succeed("systemctl restart adguardhome qbittorrent")
        client.wait_until_succeeds(curl("qbittorrent", "/api/v2/auth/login", "-f -c /tmp/qb-cookies -o /dev/null -w '%{http_code}' --data 'username=daniel&password=fixture-password'") + " | grep -Fx 204")
        client.wait_until_succeeds(curl("adguard", "/control/status", "-f -u daniel:fixture-password"))
        assert json.loads(response("qbittorrent", "/api/v2/app/preferences", "-f -b /tmp/qb-cookies"))["max_ratio"] == declared_ratio
        assert json.loads(response("adguard", "/control/filtering/status", "-f -u daniel:fixture-password"))["enabled"]
        assert_torrent_present()
        hatchi.fail(f"grep -Fx 'Retained=restored-setting' {qb_config}")
        hatchi.succeed("test -f /srv/media/downloads/permission-proof")
        assert client.succeed(f"dig @192.168.1.10 dashboard.{domain} +short").strip() == "192.168.1.10"


    def rotate_secret(name, value, unit):
        invocation = hatchi.succeed(f"systemctl show {unit} -p InvocationID --value").strip()
        hatchi.succeed("SOPS_AGE_KEY_FILE=/run/hatchi-test-age-key sops set /run/hatchi-test-secrets.yaml " + shlex.quote(json.dumps([name])) + " " + shlex.quote(json.dumps(value)))
        hatchi.succeed("SOPS_RESTART_UNITS_VIA_SYSTEMCTL=1 sops-install-secrets /etc/hatchi-test-sops-manifest.json")
        hatchi.wait_until_succeeds(f"test -n \"$(systemctl show {unit} -p InvocationID --value)\" && test \"$(systemctl show {unit} -p InvocationID --value)\" != {shlex.quote(invocation)}")


    adguard_password = hatchi.succeed("caddy hash-password --plaintext rotated-fixture").strip()
    rotate_secret("adguard-password", adguard_password, "adguardhome")
    client.wait_until_succeeds(curl("adguard", "/control/status", "-f -u daniel:rotated-fixture"))
    assert response("adguard", "/control/status", "-u daniel:fixture-password -o /dev/null -w '%{http_code}'").strip() == "401"
    assert "dns_addresses" in json.loads(response("adguard", "/control/status", "-f -u daniel:rotated-fixture"))
    salt = b"fixture-rotated-salt"
    key = hashlib.pbkdf2_hmac("sha512", b"rotated-fixture", salt, 100000)
    password = "@ByteArray(" + base64.b64encode(salt).decode() + ":" + base64.b64encode(key).decode() + ")"
    rotate_secret("qbittorrent-password", password, "qbittorrent")
    client.wait_until_succeeds(curl("qbittorrent", "/api/v2/auth/login", "-f -c /tmp/qb-cookies -o /dev/null -w '%{http_code}' --data 'username=daniel&password=rotated-fixture'") + " | grep -Fx 204")
    assert response("qbittorrent", "/api/v2/auth/login", "-o /dev/null -w '%{http_code}' --data 'username=daniel&password=fixture-password'").strip() == "401"
    assert json.loads(response("qbittorrent", "/api/v2/app/preferences", "-f -b /tmp/qb-cookies"))["max_ratio"] == declared_ratio
    assert_torrent_present()
    hatchi.fail(f"grep -Fx 'Retained=restored-setting' {qb_config}")
    hatchi.wait_until_succeeds("grep -Eq 'daniel\\s*=\\s*-pbkdf2' /run/couchdb/local.ini")
    rotate_secret("couchdb-admin", "[admins]\ndaniel = rotated-fixture\n", "couchdb")
    client.wait_until_succeeds(curl("couchdb", "/_session", "-f -u daniel:rotated-fixture"))
    assert response("couchdb", "/_session", "-u daniel:fixture-password -o /dev/null -w '%{http_code}'").strip() == "401"
    assert json.loads(response("couchdb", "/_session", "-f -u daniel:rotated-fixture"))["userCtx"]["name"] == "daniel"
    hatchi.succeed("systemctl restart couchdb")
    client.wait_until_succeeds(curl("couchdb", "/_session", "-f -u daniel:rotated-fixture"))
    assert response("couchdb", "/_session", "-u daniel:fixture-password -o /dev/null -w '%{http_code}'").strip() == "401"

    hatchi.reboot()
    hatchi.wait_for_unit("multi-user.target")
    hatchi.wait_for_unit("nginx.service", timeout=600)
    hatchi.wait_for_unit("caddy.service", timeout=600)
    client.wait_until_succeeds(curl("nextcloud", "/status.php", "-f"), timeout=600)
    client.wait_until_succeeds(curl("adguard", "/control/status", "-f -u daniel:fixture-password"))
    client.wait_until_succeeds(curl("qbittorrent", "/api/v2/auth/login", "-f -c /tmp/qb-cookies -o /dev/null -w '%{http_code}' --data 'username=daniel&password=fixture-password'") + " | grep -Fx 204")
    assert_torrent_present()
    hatchi.succeed("test -f /srv/media/downloads/permission-proof")
    nextcloud_health()
    assert response("nextcloud", "/remote.php/dav/files/daniel/proof.txt", "-f -u daniel:fixture-password") == "native-nextcloud-persistence"
    assert client.succeed(f"dig @192.168.1.10 dashboard.{domain} +tcp +short").strip() == "192.168.1.10"
  '';
}
