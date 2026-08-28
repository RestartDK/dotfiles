#!/usr/bin/env bash
# Demo-ready cobb dev environment: stack -> auth -> seed -> evidence.
# Idempotent; rerun after partial failures. Run from the cobb repo root.
set -euo pipefail

PORT=8099
RESET=0 SEED=0 FIXTURE=0 REAUTH=0 DEMO=0 VIDEO=0
AUTH_FILE="/tmp/cobb_prepare_output.json"
APP_URL="http://localhost:3000"

usage() {
  cat <<'USAGE'
usage: stack-up.sh [--port N] [--reset] [--seed] [--fixture] [--reauth] [--demo]
  --port N    process-compose port (default 8099)
  --reset     stack down + wipe .postgres/.postgres-ci (migration-checksum escape hatch)
  --seed      run testing/seed-profiles/seed-profiles.sh
  --fixture   run testing/store-analytics-fixture/seed.sh
  --reauth    force a fresh test user + JWT + API key
  --demo      headless chromium screenshot of the logged-in app
  --video     record ~20s mp4 of the logged-in app (Xvfb + ffmpeg x11grab);
              works on SPA routes where a headless screenshot never finishes loading
USAGE
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
  --port)
    PORT="$2"
    shift 2
    ;;
  --reset)
    RESET=1
    shift
    ;;
  --seed)
    SEED=1
    shift
    ;;
  --fixture)
    FIXTURE=1
    shift
    ;;
  --reauth)
    REAUTH=1
    shift
    ;;
  --demo)
    DEMO=1
    shift
    ;;
  --video)
    VIDEO=1
    shift
    ;;
  *) usage ;;
  esac
done

[ -f process-compose.yaml ] || {
  echo "FAIL: run from the cobb repo root" >&2
  exit 1
}

step() { printf '\n==> %s\n' "$1"; }
fail() {
  echo "FAIL: $1" >&2
  echo "logs: journalctl -t cobb-server --since -10min (see process-compose.yaml for other service tags)" >&2
  exit 1
}

running() { process-compose -p "$PORT" list >/dev/null 2>&1; }

jwt_expired() {
  [ -s "$AUTH_FILE" ] || return 0
  local payload exp pad
  payload=$(jq -r '.jwt // empty' "$AUTH_FILE" 2>/dev/null | cut -d. -sf2 | tr '_-' '/+')
  [ -n "$payload" ] || return 0
  pad=$(((4 - ${#payload} % 4) % 4))
  exp=$(printf '%s%.*s' "$payload" "$pad" "===" | base64 -d 2>/dev/null | jq -r '.exp // empty' 2>/dev/null)
  [ -n "$exp" ] || return 0
  [ "$exp" -lt "$(date +%s)" ]
}

if [ "$RESET" = 1 ]; then
  step "reset: stack down + wipe local postgres state"
  if running; then process-compose -p "$PORT" down || true; fi
  running && fail "stack still up on port $PORT; refusing to wipe .postgres under a live stack"
  rm -rf .postgres .postgres-ci
fi

if running; then
  step "stack already running on port $PORT; reusing it"
else
  step "killing stray stack processes"
  if [ -x bin/kill-stray-stack.sh ]; then bin/kill-stray-stack.sh --yes || true; fi
  step "starting stack (process-compose -p $PORT, detached)"
  direnv exec . process-compose -f process-compose.yaml -p "$PORT" -D up
fi

step "waiting for services to be ready"
for i in $(seq 1 90); do
  not_ready=$(process-compose -p "$PORT" list -o json 2>/dev/null |
    jq -r '[.[] | select(.status == "Pending" or .status == "Failed" or (.is_ready != "Ready" and .is_ready != "-" and .status != "Completed"))] | length' 2>/dev/null || echo unknown)
  if [ "$not_ready" = "0" ]; then break; fi
  [ "$i" = 90 ] && {
    process-compose -p "$PORT" list -o json | jq -r '.[] | [.name,.status,.is_ready] | @tsv' >&2
    fail "services not ready after 15min"
  }
  sleep 10
done
process-compose -p "$PORT" list -o json | jq -r '.[] | [.name,.status,.is_ready] | @tsv'

if [ "$REAUTH" = 1 ] || [ ! -s "$AUTH_FILE" ] || jwt_expired; then
  step "preparing auth (test user + JWT + API key)"
  direnv exec . env ENV_FILE=.env COBB_PREPARE_OUTPUT_FILE="$AUTH_FILE" ./bin/prepare-vm-environment.sh || fail "prepare-vm-environment.sh"
else
  step "auth file exists at $AUTH_FILE and JWT is valid; keeping it (--reauth to refresh)"
fi
jq -e '.jwt and .api_key' "$AUTH_FILE" >/dev/null || fail "auth file $AUTH_FILE is missing jwt/api_key"

if [ "$SEED" = 1 ]; then
  step "seeding predefined profiles"
  ./testing/seed-profiles/seed-profiles.sh || fail "seed-profiles.sh"
fi

if [ "$FIXTURE" = 1 ]; then
  step "importing store-analytics fixture"
  ./testing/store-analytics-fixture/seed.sh || {
    echo "hint: fixture import is not idempotent on a stale local DB; rerun with --reset" >&2
    fail "store-analytics-fixture/seed.sh"
  }
fi

step "endpoint evidence"
curl -fsS -o /dev/null -w "GET $APP_URL -> %{http_code}\n" "$APP_URL" || fail "app endpoint not answering at $APP_URL"

LOGIN_URL="$APP_URL/auth/dev-login?user_id=store-analytics&redirect_to=/"

CHROME=$(command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || command -v google-chrome 2>/dev/null ||
  { find /nix/store -maxdepth 3 -path '/nix/store/*-chromium-1*/bin/chromium' 2>/dev/null | sort -V | tail -1; } || true)

if [ "$DEMO" = 1 ]; then
  step "demo screenshot (headless chromium)"
  SHOT="/tmp/cobb-demo-$(date +%s).png"
  if [ -n "$CHROME" ]; then
    timeout 90 "$CHROME" --headless --disable-gpu --no-sandbox --window-size=1440,900 --screenshot="$SHOT" "$LOGIN_URL" 2>/dev/null &&
      echo "screenshot: $SHOT" || echo "WARN: screenshot failed (route may never reach load; --video records regardless); fall back to the browser skill" >&2
  else
    echo "WARN: no chromium found; fall back to the browser skill" >&2
  fi
fi

if [ "$VIDEO" = 1 ]; then
  step "demo video (Xvfb + ffmpeg x11grab)"
  VID="/tmp/cobb-demo-$(date +%s).mp4"
  XVFB=$(command -v Xvfb 2>/dev/null || { find /nix/store -maxdepth 3 -path '/nix/store/*-xorg-server-2*/bin/Xvfb' 2>/dev/null | sort -V | tail -1; } || true)
  FFMPEG=$(command -v ffmpeg 2>/dev/null || true)
  if [ -n "$FFMPEG" ] && ! "$FFMPEG" -hide_banner -formats 2>/dev/null | grep -q x11grab; then FFMPEG=""; fi
  if [ -z "$FFMPEG" ]; then
    FFMPEG=$(find /nix/store -maxdepth 3 -path '/nix/store/*-ffmpeg-full-*-bin/bin/ffmpeg' 2>/dev/null | sort -V | tail -1 || true)
  fi
  if [ -n "$XVFB" ] && [ -n "$FFMPEG" ] && [ -n "$CHROME" ]; then
    DISP=$((RANDOM % 100 + 100))
    PROFILE=$(mktemp -d)
    "$XVFB" :$DISP -screen 0 1440x900x24 >/dev/null 2>&1 &
    XVFB_PID=$!
    sleep 1
    DISPLAY=:$DISP "$CHROME" --no-sandbox --disable-gpu --kiosk --window-size=1440,900 --user-data-dir="$PROFILE" "$LOGIN_URL" >/dev/null 2>&1 &
    sleep 3
    DISPLAY=:$DISP "$FFMPEG" -y -loglevel error -f x11grab -video_size 1440x900 -framerate 25 -i :$DISP -t "${VIDEO_SECONDS:-20}" -c:v libx264 -pix_fmt yuv420p -preset veryfast "$VID"
    pkill -9 -f "$PROFILE" 2>/dev/null || true
    kill "$XVFB_PID" 2>/dev/null || true
    rm -rf "$PROFILE"
    [ -s "$VID" ] && echo "video: $VID" || echo "WARN: video produced no file" >&2
  else
    echo "WARN: --video needs chromium, Xvfb, and an x11grab-capable ffmpeg (nix shell nixpkgs#xorg-server nixpkgs#ffmpeg-full)" >&2
  fi
fi

step "summary"
cat <<SUMMARY
stack:      up on process-compose port $PORT
app:        $APP_URL
login:      $LOGIN_URL
auth file:  $AUTH_FILE (COBB_JWT=jq -r .jwt, COBB_API_KEY=jq -r .api_key)
seeded:     profiles=$SEED fixture=$FIXTURE
netns:      $(ip netns identify $$ 2>/dev/null || echo default) (stack is only reachable inside this namespace)
teardown:   process-compose -p $PORT down; then bin/kill-stray-stack.sh --yes for orphans
SUMMARY
