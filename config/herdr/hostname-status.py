#!/usr/bin/env python3
import re
import socket
import sys
from pathlib import Path

ICONS = {
    "darwin": "\uf179",
    "win32": "\uf17a",
    "nixos": "\uf313",
    "linux": "\uf17c",
}


def os_icon(platform_name, os_release):
    if platform_name in ("darwin", "win32"):
        return ICONS[platform_name]
    if re.search(r'^ID="?nixos"?$', os_release, re.MULTILINE):
        return ICONS["nixos"]
    return ICONS["linux"]


def main():
    try:
        release = Path("/etc/os-release").read_text(encoding="utf-8")
    except OSError:
        release = ""
    print(f"{os_icon(sys.platform, release)} {socket.gethostname()}")


if __name__ == "__main__":
    main()
