import base64
from http.client import HTTPConnection
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import subprocess
import sys
import time
from urllib.parse import urlencode


RAW = Path("/run/hatchi-onepassword")
RENDERED = Path("/run/hatchi-secrets")


def password(name):
    return (RAW / name).read_text()


def basic(username, value):
    return "Basic " + base64.b64encode(f"{username}:{value}".encode()).decode()


def request(port, method, path, headers=None, body=None, *, timeout=20):
    connection = HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, response.getheaders(), response.read()
    finally:
        connection.close()


def wait_ready(predicate):
    deadline = time.monotonic() + 30
    while True:
        try:
            if predicate():
                return
        except OSError:
            pass
        if time.monotonic() >= deadline:
            raise TimeoutError("Service readiness deadline")
        time.sleep(0.25)


def check_ready():
    def ready():
        renderer = subprocess.run(
            ["systemctl", "is-active", "--quiet", "hatchi-secret-files"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if renderer.returncode:
            return False
        for port in [3000, 3001, 5984, 8081, 8080, 11000]:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                pass
        return True

    wait_ready(ready)


def check_permissions():
    for path in RAW.iterdir():
        info = path.stat()
        assert info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o400
    for path in RENDERED.iterdir():
        info = path.stat()
        owner = "grafana" if path.name.startswith("grafana-") else "root"
        assert info.st_uid == pwd.getpwnam(owner).pw_uid
        assert stat.S_IMODE(info.st_mode) == 0o400
        assert (
            subprocess.run(
                ["runuser", "-u", "nobody", "--", "test", "-r", str(path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode
            == 1
        )
    assert len(list(RAW.iterdir())) == 10
    assert len(list(RENDERED.iterdir())) == 9
    token = Path("/run/secrets/opnix-token").stat()
    assert token.st_uid == 0 and stat.S_IMODE(token.st_mode) == 0o640
    for path in [
        Path("/var/lib/sops/age/keys.txt"),
        Path("/var/lib/sops/srv-hatchi.yaml"),
    ]:
        info = path.stat()
        assert info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600


def check_adguard():
    status, _, body = request(
        3000,
        "GET",
        "/control/status",
        {
            "Authorization": basic("daniel", password("adguardPassword")),
        },
    )
    assert status == 200 and "dns_addresses" in json.loads(body)


def check_grafana():
    def ready():
        status, _, body = request(3001, "GET", "/api/health", timeout=1)
        return status == 200 and json.loads(body)["database"] == "ok"

    wait_ready(ready)
    status, _, body = request(
        3001,
        "GET",
        "/api/user",
        {
            "Authorization": basic("daniel", password("grafanaPassword")),
        },
    )
    assert status == 200 and json.loads(body)["login"] == "daniel"


def check_couchdb():
    status, _, body = request(
        5984,
        "GET",
        "/_session",
        {
            "Authorization": basic(
                password("couchdbUsername"), password("couchdbPassword")
            ),
        },
    )
    assert status == 200 and "_admin" in json.loads(body)["userCtx"]["roles"]


def check_glance():
    status, headers, _ = request(
        8081,
        "POST",
        "/api/authenticate",
        {
            "Content-Type": "application/json",
        },
        json.dumps({"username": "daniel", "password": password("glancePassword")}),
    )
    assert status == 200 and any(name.lower() == "set-cookie" for name, _ in headers)


def check_qbittorrent():
    headers = {
        "Host": "qbittorrent.chateauducipieres.com",
        "Origin": "http://qbittorrent.chateauducipieres.com",
        "Content-Type": "application/x-www-form-urlencoded",
    }
    status, response_headers, _ = request(
        8080,
        "POST",
        "/api/v2/auth/login",
        headers,
        urlencode({"username": "daniel", "password": password("qbittorrentPassword")}),
    )
    assert status in (200, 204)
    cookies = SimpleCookie()
    for name, value in response_headers:
        if name.lower() == "set-cookie":
            cookies.load(value)
    assert cookies
    headers["Cookie"] = "; ".join(
        f"{name}={cookie.value}" for name, cookie in cookies.items()
    )
    status, _, body = request(8080, "GET", "/api/v2/app/version", headers)
    assert status == 200 and body.startswith(b"v")


def check_nextcloud():
    status, _, _ = request(
        11000,
        "PROPFIND",
        "/remote.php/dav/files/daniel/",
        {
            "Host": "nextcloud.chateauducipieres.com",
            "X-Forwarded-Proto": "https",
            "Authorization": basic("daniel", password("nextcloudPassword")),
            "Depth": "0",
        },
    )
    assert status == 207
    user = subprocess.run(
        ["nextcloud-occ", "user:info", "daniel", "--output=json"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "admin" in json.loads(user.stdout)["groups"]


def main():
    if socket.gethostname() != "hatchi-op-test" or os.geteuid() != 0:
        sys.exit("Run only as root inside the disposable hatchi-op-test machine")
    checks = {
        "service readiness": check_ready,
        "secret-file permissions": check_permissions,
        "AdGuard login": check_adguard,
        "Grafana login": check_grafana,
        "CouchDB fresh-instance administrator login": check_couchdb,
        "Glance login": check_glance,
        "qBittorrent login": check_qbittorrent,
        "Nextcloud WebDAV login": check_nextcloud,
    }
    failed = False
    for name, check in checks.items():
        try:
            check()
            print(f"PASS: {name}")
        except Exception as error:
            failed = True
            print(f"FAIL: {name} ({type(error).__name__})")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
