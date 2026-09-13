import base64
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import sys
import tempfile

import bcrypt


def read_secret(directory: Path, name: str) -> str:
    value = (directory / name).read_text()
    if not value or any(char in value for char in "\r\n\0"):
        raise ValueError(f"{name} must contain one nonempty line")
    return value


def render(manifest: dict) -> dict[str, tuple[str, str]]:
    raw = Path(manifest["rawDirectory"])
    names = [
        "cloudflare",
        "adguardPassword",
        "couchdbUsername",
        "couchdbPassword",
        "glanceKey",
        "glancePassword",
        "grafanaKey",
        "grafanaPassword",
        "nextcloudPassword",
        "qbittorrentPassword",
    ]
    secrets = {name: read_secret(raw, name) for name in names}
    if not re.fullmatch(r"[A-Za-z0-9_-]+", secrets["cloudflare"]):
        raise ValueError(
            "cloudflare token is not valid for the provider environment file"
        )
    if not re.fullmatch(r"[A-Za-z0-9_.@-]+", secrets["couchdbUsername"]):
        raise ValueError("couchdbUsername is not a valid INI administrator name")
    if len(base64.b64decode(secrets["glanceKey"], validate=True)) != 64:
        raise ValueError("glanceKey must be a base64-encoded 64-byte key")

    adguard = manifest["adguard"]
    password = secrets["adguardPassword"].encode()
    if len(password) > 72:
        raise ValueError("adguardPassword exceeds bcrypt's 72-byte limit")
    adguard["users"][0]["password"] = bcrypt.hashpw(
        password, bcrypt.gensalt(rounds=10)
    ).decode()

    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha512", secrets["qbittorrentPassword"].encode(), salt, 100000
    )
    qbittorrent = manifest["qbittorrent"]
    qbittorrent["Preferences"]["WebUI\\Password_PBKDF2"] = (
        f"@ByteArray({base64.b64encode(salt).decode()}:{base64.b64encode(digest).decode()})"
    )
    sections = []
    for section, values in qbittorrent.items():
        lines = [f"[{section}]"]
        for name, value in values.items():
            if isinstance(value, bool):
                value = str(value).lower()
            lines.append(f"{name}={value}")
        sections.append("\n".join(lines))

    return {
        "cloudflare": (f"CF_DNS_API_TOKEN={secrets['cloudflare']}\n", "root"),
        "AdGuardHome.yaml": (json.dumps(adguard), "root"),
        "qBittorrent.conf": ("\n\n".join(sections) + "\n", "root"),
        "couchdb-admin": (
            f"[admins]\n{secrets['couchdbUsername']} = {secrets['couchdbPassword']}\n",
            "root",
        ),
        "glance-key": (secrets["glanceKey"], "root"),
        "glance-password": (secrets["glancePassword"], "root"),
        "grafana-key": (secrets["grafanaKey"], "grafana"),
        "grafana-password": (secrets["grafanaPassword"], "grafana"),
        "nextcloud-admin": (secrets["nextcloudPassword"], "root"),
    }


def main() -> None:
    manifest_path, output_path = sys.argv[1:]
    files = render(json.loads(Path(manifest_path).read_text()))
    output = Path(output_path)
    with tempfile.TemporaryDirectory(dir=output) as staging:
        for name, (content, owner) in files.items():
            target = Path(staging) / name
            target.write_text(content)
            account = pwd.getpwnam(owner)
            os.chown(target, account.pw_uid, account.pw_gid)
            target.chmod(0o400)
        for name in files:
            os.replace(Path(staging) / name, output / name)
    print(f"Rendered {len(files)} application credential files")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError):
        sys.exit(
            "Hatchi credential rendering failed; check references, formats, and permissions"
        )
