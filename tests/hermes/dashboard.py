import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from hermes_cli.config_defaults import DEFAULT_CONFIG


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
environment = {
    **{key: os.environ[key] for key in ("PATH", "LANG", "TMPDIR", "SSL_CERT_FILE") if key in os.environ},
    "HOME": str(home),
    "HERMES_HOME": str(state),
    "HERMES_MANAGED": "true",
    "HERMES_DASHBOARD_SESSION_TOKEN": "synthetic-dashboard-token-for-hermes-check",
}
binary = str(package / "bin" / "hermes")
subprocess.run([binary, "--version"], env=environment, check=True, timeout=60)
assert (package / "ui-tui" / "dist" / "entry.js").is_file()
assert (package / "share" / "hermes-agent" / "web_dist" / "index.html").is_file()

with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]

base_url = f"http://127.0.0.1:{port}"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(path, authenticated=True):
    headers = {}
    if authenticated:
        headers["X-Hermes-Session-Token"] = environment["HERMES_DASHBOARD_SESSION_TOKEN"]
    return opener.open(urllib.request.Request(base_url + path, headers=headers), timeout=5)


for attempt in range(2):
    with (root / f"dashboard-{attempt}.log").open("w") as log:
        process = subprocess.Popen(
            [binary, "dashboard", "--host", "127.0.0.1", "--port", str(port), "--no-open"],
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 60
            while True:
                if process.poll() is not None:
                    raise RuntimeError((root / f"dashboard-{attempt}.log").read_text())
                try:
                    with request("/") as response:
                        html = response.read().decode()
                    break
                except urllib.error.HTTPError:
                    raise
                except (urllib.error.URLError, TimeoutError):
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.1)
            assert "<html" in html.lower() and "/assets/" in html
            with request("/chat") as response:
                assert response.status == 200
            try:
                request("/api/config", authenticated=False)
                raise AssertionError("Dashboard configuration accepted an unauthenticated request")
            except urllib.error.HTTPError as error:
                assert error.code == 401, error.code
            with request("/api/config") as response:
                config = json.load(response)
            assert config["model"] == settings["model"]["default"], config["model"]
            with request("/api/memory") as response:
                memory = json.load(response)
            assert memory["builtin_files"]["memory"] == len("Synthetic Hatchi runtime check.")
            print(f"Dashboard pass {attempt + 1}: SPA, chat route, API auth, persisted state", flush=True)
        except BaseException:
            print((root / f"dashboard-{attempt}.log").read_text(), file=sys.stderr)
            raise
        finally:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)

print(f"Hermes package and dashboard contracts passed; evidence at {root}", flush=True)
