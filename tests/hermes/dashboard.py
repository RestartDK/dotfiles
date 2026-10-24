import contextlib
import http.cookiejar
import json
import os
import pathlib
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from hermes_cli.config_defaults import DEFAULT_CONFIG
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect


package = pathlib.Path(sys.argv[1])
fixture = json.loads(pathlib.Path(sys.argv[2]).read_text())
root = pathlib.Path(tempfile.mkdtemp(prefix="hermes-check-"))
print(f"Hermes runtime evidence: {root}", flush=True)
home = root / "home"
state = home / ".hermes"
state.mkdir(parents=True)
for rule in fixture["tmpfiles"]:
    fields = rule.split()
    prefix = "/var/lib/hermes/.hermes/"
    if fields[0] == "d" and fields[1].startswith(prefix):
        assert fields[3:5] == ["hermes", "hermes"], rule
        mode = int(fields[2], 8)
        assert mode & 0o007 == 0, rule
        directory = state / fields[1].removeprefix(prefix)
        directory.mkdir(parents=True, exist_ok=True)
        directory.chmod(mode & 0o777)
settings = fixture["settings"]
settings["_config_version"] = DEFAULT_CONFIG["_config_version"]
settings["terminal"]["cwd"] = str(root)
(state / "config.yaml").write_text(json.dumps(settings))
(state / "memories" / "MEMORY.md").write_text("Synthetic Hatchi runtime check.")
credentials = root / "credentials"
credentials.mkdir(mode=0o700)
values = {
    "OPENCODE_GO_API_KEY": "synthetic-go-key-with-'quotes'-$dollars",
    "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD": 'synthetic-dashboard-password-"quoted"-$literal',
}
for variable, value in values.items():
    path = credentials / variable
    path.write_text(value)
    path.chmod(0o400)
environment = {
    **fixture["dashboardEnvironment"],
    **{key: os.environ[key] for key in ("PATH", "LANG", "TMPDIR", "SSL_CERT_FILE") if key in os.environ},
    "HOME": str(home),
    "HERMES_HOME": str(state),
    "HERMES_MANAGED": "true",
    "CREDENTIALS_DIRECTORY": str(credentials),
    "OPENCODE_GO_BASE_URL": "http://127.0.0.1:9/v1",
}
binary = str(package / "bin" / "hermes")
subprocess.run([binary, "--version"], env=environment, check=True, timeout=60)
assert (package / "ui-tui" / "dist" / "entry.js").is_file()
assert (package / "share" / "hermes-agent" / "web_dist" / "index.html").is_file()

for variable in values:
    path = credentials / variable
    absent = credentials / f"{variable}.absent"
    path.rename(absent)
    try:
        result = subprocess.run(
            [fixture["command"]], env=environment, capture_output=True, text=True, timeout=10
        )
        assert result.returncode != 0, f"Missing {variable} did not prevent startup"
        assert variable in result.stderr, result.stderr
    finally:
        absent.rename(path)
print("Missing API-key and login-password credentials fail closed", flush=True)

with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    proxy_port = probe.getsockname()[1]
hostname = urllib.parse.urlparse(environment["HERMES_DASHBOARD_PUBLIC_URL"]).hostname
base_url = f"https://{hostname}:{proxy_port}"
backend_url = f"http://{fixture['backend']['host']}:{fixture['backend']['port']}"
original_getaddrinfo = socket.getaddrinfo


def local_dns(host, *args, **kwargs):
    return original_getaddrinfo("127.0.0.1" if host == hostname else host, *args, **kwargs)


socket.getaddrinfo = local_dns
caddy_config = root / "Caddyfile"
caddy_config.write_text(
    "{\nadmin off\nauto_https disable_redirects\nskip_install_trust\npersist_config off\n}\n"
    f"{base_url} {{\nbind 127.0.0.1\ntls internal\n{fixture['proxy']}\n}}\n"
)
caddy_environment = {
    **environment,
    "XDG_DATA_HOME": str(root / "caddy-data"),
    "XDG_CONFIG_HOME": str(root / "caddy-config"),
}
cookies = http.cookiejar.CookieJar()
context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context),
    urllib.request.HTTPCookieProcessor(cookies),
)
anonymous = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context),
)


def request(path, data=None, authenticated=True, headers=None):
    payload = json.dumps(data).encode() if data is not None else None
    request_headers = dict(headers or {})
    if payload is not None:
        request_headers.update({"Content-Type": "application/json", "Origin": base_url})
    client = opener if authenticated else anonymous
    return client.open(
        urllib.request.Request(base_url + path, data=payload, headers=request_headers), timeout=10
    )


def denied(path, data=None, authenticated=False):
    try:
        request(path, data=data, authenticated=authenticated)
        raise AssertionError(f"Unauthenticated or invalid request accepted: {path}")
    except urllib.error.HTTPError as error:
        assert error.code == 401, (path, error.code)


def websocket(ticket="", origin=None):
    query = urllib.parse.urlencode({"channel": "hermes-check", "ticket": ticket})
    return connect(
        base_url.replace("https://", "wss://") + "/api/events?" + query,
        ssl=context, origin=origin or base_url, proxy=None, open_timeout=10,
    )


def denied_websocket(ticket="", origin=None):
    try:
        with websocket(ticket, origin):
            raise AssertionError("Unauthenticated, replayed or cross-origin WebSocket accepted")
    except InvalidStatus as error:
        assert error.response.status_code == 403, error.response.status_code


def stop(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


with contextlib.ExitStack() as cleanup, (root / "caddy.log").open("w") as log:
    gateway_log = cleanup.enter_context((root / "gateway.log").open("w"))
    gateway_environment = {
        key: value for key, value in environment.items() if not key.startswith("HERMES_DASHBOARD_")
    }
    gateway = subprocess.Popen(
        [fixture["gatewayCommand"]], env=gateway_environment, cwd=root,
        stdout=gateway_log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    cleanup.callback(stop, gateway)
    caddy = subprocess.Popen(
        [fixture["caddy"], "run", "--config", str(caddy_config), "--adapter", "caddyfile"],
        env=caddy_environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    cleanup.callback(stop, caddy)
    try:
        ca_file = root / "caddy-data/caddy/pki/authorities/local/root.crt"
        deadline = time.monotonic() + 30
        while not ca_file.is_file():
            if caddy.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError((root / "caddy.log").read_text())
            time.sleep(0.1)
        context.load_verify_locations(cafile=str(ca_file))
        for attempt in range(2):
            log_file = root / f"dashboard-{attempt}.log"
            with log_file.open("w") as dashboard_log:
                process = subprocess.Popen(
                    [fixture["command"]], env=environment, cwd=root,
                    stdout=dashboard_log, stderr=subprocess.STDOUT, start_new_session=True,
                )
                try:
                    deadline = time.monotonic() + 60
                    while True:
                        if process.poll() is not None:
                            raise RuntimeError(log_file.read_text())
                        if gateway.poll() is not None:
                            raise RuntimeError(
                                "Native gateway exited before readiness:\n"
                                + (root / "gateway.log").read_text()
                                + (state / "logs/agent.log").read_text()
                            )
                        try:
                            with request("/api/status", authenticated=False) as response:
                                status = json.load(response)
                            assert status["auth_required"] and "basic" in status["auth_providers"]
                            if status["gateway_running"]:
                                break
                            if time.monotonic() >= deadline:
                                raise TimeoutError("Native gateway did not become ready")
                            time.sleep(0.1)
                        except urllib.error.HTTPError as error:
                            if error.code != 502:
                                raise
                            if time.monotonic() >= deadline:
                                raise
                            time.sleep(0.1)
                        except (urllib.error.URLError, TimeoutError):
                            if time.monotonic() >= deadline:
                                raise
                            time.sleep(0.1)
                    if attempt:
                        denied("/api/config", authenticated=True)
                    cookies.clear()
                    with request("/") as response:
                        html = response.read().decode()
                    assert "<html" in html.lower() and "password" in html and "username" in html
                    assert "window.__HERMES_SESSION_TOKEN__" not in html
                    denied("/api/config")
                    denied("/api/auth/ws-ticket", data={})
                    denied_websocket()
                    denied("/auth/password-login", data={
                        "provider": "basic", "username": "daniel", "password": "incorrect",
                    })
                    with request("/auth/password-login", data={
                        "provider": "basic", "username": "daniel",
                        "password": values["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD"],
                    }) as response:
                        assert json.load(response)["ok"]
                    assert cookies and all(cookie.secure for cookie in cookies)
                    with request("/api/auth/me") as response:
                        assert json.load(response)["user_id"] == "daniel"
                    with request("/chat") as response:
                        assert "/assets/" in response.read().decode()
                    with request("/api/config") as response:
                        config_body = response.read().decode()
                    config = json.loads(config_body)
                    assert config["model"] == settings["model"]["default"], config["model"]
                    assert all(value not in config_body + html for value in values.values())
                    with request("/api/memory") as response:
                        memory = json.load(response)
                    assert memory["builtin_files"]["memory"] == len("Synthetic Hatchi runtime check.")
                    with request("/login", headers={"X-Forwarded-Prefix": "/attacker"}) as response:
                        assert "/attacker/" not in response.read().decode()
                    try:
                        anonymous.open(urllib.request.Request(
                            backend_url + "/api/health", headers={"Host": "evil.invalid"},
                        ), timeout=5)
                        raise AssertionError("Untrusted Host accepted by the backend")
                    except urllib.error.HTTPError as error:
                        assert error.code == 400, error.code
                    with request("/api/auth/ws-ticket", data={}) as response:
                        ticket = json.load(response)["ticket"]
                    denied_websocket(ticket, "https://evil.invalid")
                    with request("/api/auth/ws-ticket", data={}) as response:
                        ticket = json.load(response)["ticket"]
                    with websocket(ticket):
                        pass
                    denied_websocket(ticket)
                    print(
                        f"Dashboard pass {attempt + 1}: live native gateway, verified HTTPS proxy, native login, private API, "
                        "secure cookies, exact Host/Origin, one-use WebSocket ticket and persisted memory",
                        flush=True,
                    )
                except BaseException:
                    print(log_file.read_text(), file=sys.stderr)
                    raise
                finally:
                    stop(process)
    except BaseException:
        print((root / "caddy.log").read_text(), file=sys.stderr)
        raise
    finally:
        socket.getaddrinfo = original_getaddrinfo

print(f"Hermes package and authenticated Caddy contracts passed; evidence at {root}", flush=True)
