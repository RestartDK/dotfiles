#!/usr/bin/env python3
import json
import math
import os
import tempfile
import time
import urllib.request
from pathlib import Path

CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "herdr-usage"
CLAUDE_CACHE = CACHE_DIR / "claude.json"
CODEX_CACHE = CACHE_DIR / "codex.json"
CODEX_RETRY = CACHE_DIR / "codex-retry.json"
REFRESH_SECONDS = 300
STALE_SECONDS = 1800


def read_json(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value
    return None


def save_json(path, value):
    CACHE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=CACHE_DIR, delete=False) as file:
        json.dump(value, file, separators=(",", ":"))
        file.write("\n")
        temporary = Path(file.name)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def fetch_codex(now):
    auth_path = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "auth.json"
    auth = read_json(auth_path)
    if auth.get("auth_mode") != "chatgpt":
        return None
    tokens = auth.get("tokens")
    if not isinstance(tokens, dict) or not isinstance(tokens.get("access_token"), str):
        return None
    headers = {
        "Authorization": f"Bearer {tokens['access_token']}",
        "User-Agent": "codex-cli/1.0",
    }
    if isinstance(tokens.get("account_id"), str):
        headers["ChatGPT-Account-Id"] = tokens["account_id"]
    request = urllib.request.Request("https://chatgpt.com/backend-api/wham/usage", headers=headers)
    with urllib.request.urlopen(request, timeout=4) as response:
        data = json.load(response)
    rate_limit = data.get("rate_limit") if isinstance(data, dict) else None
    if not isinstance(rate_limit, dict):
        return None
    windows = []
    for name in ("primary_window", "secondary_window"):
        window = rate_limit.get(name)
        if not isinstance(window, dict):
            continue
        percent = number(window.get("used_percent"))
        seconds = number(window.get("limit_window_seconds"))
        if percent is None or not 0 <= percent <= 1000 or seconds is None or seconds <= 0:
            continue
        reset_at = number(window.get("reset_at"))
        windows.append({
            "percent": percent,
            "window_seconds": int(seconds),
            "reset_at": int(reset_at) if reset_at is not None else None,
        })
    return {"at": now, "windows": windows} if windows else None


def codex_usage(now):
    cached = read_json(CODEX_CACHE)
    at = number(cached.get("at"))
    if at is not None and 0 <= now - at < REFRESH_SECONDS:
        return cached
    retry_at = number(read_json(CODEX_RETRY).get("retry_at"))
    if retry_at is not None and now < retry_at:
        return cached
    try:
        fresh = fetch_codex(now)
        if fresh is None:
            raise ValueError("no usage windows")
        save_json(CODEX_CACHE, fresh)
        return fresh
    except (OSError, ValueError, TypeError):
        try:
            save_json(CODEX_RETRY, {"retry_at": now + REFRESH_SECONDS})
        except OSError:
            pass
        return cached


def window_label(seconds):
    if seconds < 3600:
        return f"{max(1, round(seconds / 60))}m"
    if seconds < 86400:
        return f"{max(1, round(seconds / 3600))}h"
    return f"{max(1, round(seconds / 86400))}d"


def stale(cache, reset_at, now):
    at = number(cache.get("at"))
    reset = number(reset_at)
    return at is None or at > now + 60 or now - at > STALE_SECONDS or (reset is not None and reset <= now)


def claude_percentage(cache, key, now):
    percent = number(cache.get(key))
    if percent is None or not 0 <= percent <= 1000:
        return None
    resets = cache.get("resets_at")
    reset = number(resets.get(key)) if isinstance(resets, dict) else None
    if reset is not None and reset <= now:
        return None
    if reset is None and stale(cache, None, now):
        return None
    return percent


def claude_label(cache, now):
    five_hour = claude_percentage(cache, "five_hour", now)
    weekly = claude_percentage(cache, "seven_day", now)
    if five_hour is not None and round(five_hour) > 0:
        return f"claude {five_hour:.0f}%"
    if weekly is not None:
        return f"claude {weekly:.0f}% weekly"
    if five_hour is not None:
        return "claude 0%"
    return "claude n/a"


def gpt_label(cache, now):
    windows = []
    entries = cache.get("windows")
    for window in entries if isinstance(entries, list) else []:
        if not isinstance(window, dict):
            continue
        percent = number(window.get("percent"))
        seconds = number(window.get("window_seconds"))
        if percent is None or not 0 <= percent <= 1000 or seconds is None or seconds <= 0:
            continue
        suffix = "*" if stale(cache, window.get("reset_at"), now) else ""
        windows.append((seconds, percent, suffix))
    if not windows:
        return "gpt n/a"
    show_window = len(windows) > 1
    return "gpt " + " ".join(
        f"{window_label(seconds) + ':' if show_window else ''}{percent:.0f}%{suffix}"
        for seconds, percent, suffix in windows
    )


def main():
    now = int(time.time())
    codex = codex_usage(now)
    print(f"{claude_label(read_json(CLAUDE_CACHE), now)} · {gpt_label(codex, now)}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("claude n/a · gpt n/a")
