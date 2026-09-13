import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

import bcrypt

spec = importlib.util.spec_from_file_location("render_secrets", sys.argv.pop(1))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class SecretFormats(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.raw = Path(self.directory.name)
        self.values = {
            "cloudflare": "fixture-api-token",
            "adguardPassword": "fixture-password",
            "couchdbUsername": "daniel",
            "couchdbPassword": "fixture-password",
            "glanceKey": base64.b64encode(bytes(range(64))).decode(),
            "glancePassword": "fixture-password",
            "grafanaKey": "fixture-grafana-key",
            "grafanaPassword": "fixture-password",
            "nextcloudPassword": "fixture-password",
            "qbittorrentPassword": "fixture-password",
        }
        for name, value in self.values.items():
            (self.raw / name).write_text(value)
        self.manifest = {
            "rawDirectory": str(self.raw),
            "adguard": {
                "users": [{"name": "daniel", "password": ""}],
                "dns": {"port": 53},
            },
            "qbittorrent": {
                "Preferences": {
                    "WebUI\\Username": "daniel",
                    "WebUI\\LocalHostAuth": True,
                    "WebUI\\Password_PBKDF2": "",
                },
            },
        }

    def test_service_formats(self):
        files = renderer.render(self.manifest)
        self.assertEqual(len(files), 9)
        adguard = json.loads(files["AdGuardHome.yaml"][0])
        self.assertTrue(
            bcrypt.checkpw(
                b"fixture-password", adguard["users"][0]["password"].encode()
            )
        )
        self.assertEqual(adguard["dns"]["port"], 53)
        qbittorrent = files["qBittorrent.conf"][0]
        encoded = qbittorrent.split("WebUI\\Password_PBKDF2=@ByteArray(", 1)[1].split(
            ")", 1
        )[0]
        salt, digest = [base64.b64decode(part) for part in encoded.split(":")]
        self.assertEqual(
            digest, hashlib.pbkdf2_hmac("sha512", b"fixture-password", salt, 100000)
        )
        self.assertIn("WebUI\\LocalHostAuth=true\n", qbittorrent)
        self.assertNotIn("fixture-password", qbittorrent)
        self.assertEqual(
            files["couchdb-admin"][0], "[admins]\ndaniel = fixture-password\n"
        )
        self.assertEqual(files["cloudflare"][0], "CF_DNS_API_TOKEN=fixture-api-token\n")
        self.assertEqual(files["grafana-password"][1], "grafana")
        self.assertEqual(files["nextcloud-admin"][1], "root")

    def test_missing_field_fails(self):
        (self.raw / "grafanaKey").unlink()
        with self.assertRaises(FileNotFoundError):
            renderer.render(self.manifest)

    def test_line_injection_fails(self):
        for value in [
            "",
            "password\n[admins]\nattacker = password",
            "password\rvalue",
            "password\0value",
        ]:
            with self.subTest(value=value):
                (self.raw / "couchdbPassword").write_text(value)
                with self.assertRaises(ValueError):
                    renderer.render(self.manifest)

    def test_invalid_username_fails(self):
        (self.raw / "couchdbUsername").write_text("daniel=attacker")
        with self.assertRaises(ValueError):
            renderer.render(self.manifest)

    def test_invalid_glance_key_fails(self):
        for value in ["not-base64", base64.b64encode(b"too short").decode()]:
            (self.raw / "glanceKey").write_text(value)
            with self.assertRaises(ValueError):
                renderer.render(self.manifest)

    def test_long_bcrypt_password_is_not_truncated(self):
        (self.raw / "adguardPassword").write_text("x" * 73)
        with self.assertRaises(ValueError):
            renderer.render(self.manifest)

    def test_environment_injection_fails(self):
        (self.raw / "cloudflare").write_text('token" MALICIOUS=value')
        with self.assertRaises(ValueError):
            renderer.render(self.manifest)


unittest.main()
