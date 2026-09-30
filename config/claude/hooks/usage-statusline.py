#!/usr/bin/env python3
import json
import math
import os
import sys
import tempfile
import time
from pathlib import Path

CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "herdr-usage"


def percentage(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value if 0 <= value <= 1000 else None
    return None


def text(value):
    if not isinstance(value, str):
        return ""
    return "".join(char for char in value if char.isprintable() and char != "\x1b").strip()[:60]


def save_usage(value):
    CACHE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=CACHE_DIR, delete=False) as file:
        json.dump(value, file, separators=(",", ":"))
        file.write("\n")
        temporary = Path(file.name)
    try:
        temporary.replace(CACHE_DIR / "claude.json")
    finally:
        temporary.unlink(missing_ok=True)


def main():
    try:
        payload = json.load(sys.stdin)
    except (OSError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    model = payload.get("model") if isinstance(payload.get("model"), dict) else {}
    workspace = payload.get("workspace") if isinstance(payload.get("workspace"), dict) else {}
    context = payload.get("context_window") if isinstance(payload.get("context_window"), dict) else {}
    limits = payload.get("rate_limits") if isinstance(payload.get("rate_limits"), dict) else {}
    cwd = workspace.get("current_dir")
    parts = [part for part in (text(model.get("display_name")), text(Path(cwd).name) if isinstance(cwd, str) else "") if part]
    remaining = percentage(context.get("remaining_percentage"))
    if remaining is not None:
        parts.append(f"{remaining:.0f}% left")

    usage = {"at": int(time.time())}
    resets = {}
    windows = []
    for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
        window = limits.get(key)
        if not isinstance(window, dict):
            continue
        percent = percentage(window.get("used_percentage"))
        if percent is None:
            continue
        usage[key] = percent
        windows.append(f"{label}:{percent:.0f}%")
        reset_at = window.get("resets_at")
        if isinstance(reset_at, (int, float)) and not isinstance(reset_at, bool) and math.isfinite(reset_at):
            resets[key] = int(reset_at)
    if windows:
        usage["resets_at"] = resets
        try:
            save_usage(usage)
        except OSError:
            pass
        parts.append(" ".join(windows))
    print(" · ".join(parts) if parts else "Claude")


if __name__ == "__main__":
    main()
