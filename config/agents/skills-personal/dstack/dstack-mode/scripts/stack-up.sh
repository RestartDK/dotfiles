#!/usr/bin/env bash
# Demo-ready cobb dev environment: stack -> auth -> seed -> evidence.
# Idempotent; rerun after partial failures. Run from the cobb repo root.
set -euo pipefail

PORT=8099
RESET=0 SEED=0 FIXTURE=0 REAUTH=0 DEMO=0
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
USAGE
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --reset) RESET=1; shift ;;
    --seed) SEED=1; shift ;;
    --fixture) FIXTURE=1; shift ;;
    --reauth) REAUTH=1; shift ;;
    --demo) DEMO=1; shift ;;
    *) usage ;;
  esac
done

[ -f process-compose.yaml ] || { echo "FAIL: run from the cobb repo root" >&2; exit 1; }

step() { printf '\n==> %s\n' "$1"; }
fail() { echo "FAIL: $1" >&2; echo "logs: journalctl -t cobb-server --since -10min (see process-compose.yaml for other service tags)" >&2; exit 1; }

running() { process-compose -p "$PORT" list >/dev/null 2>&1; }

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
  not_ready=$(process-compose -p "$PORT" list -o json 2>/dev/null \
    | jq -r '[.[] | select(.status == "Pending" or .status == "Failed" or (.is_ready != "Ready" and .is_ready != "-" and .status != "Completed"))] | length' 2>/dev/null || echo unknown)
  if [ "$not_ready" = "0" ]; then break; fi
  [ "$i" = 90 ] && { process-compose -p "$PORT" list -o json | jq -r '.[] | [.name,.status,.is_ready] | @tsv' >&2; fail "services not ready after 15min"; }
  sleep 10
done
process-compose -p "$PORT" list -o json | jq -r '.[] | [.name,.status,.is_ready] | @tsv'

if [ "$REAUTH" = 1 ] || [ ! -s "$AUTH_FILE" ]; then
  step "preparing auth (test user + JWT + API key)"
  direnv exec . env ENV_FILE=.env COBB_PREPARE_OUTPUT_FILE="$AUTH_FILE" ./bin/prepare-vm-environment.sh || fail "prepare-vm-environment.sh"
else
  step "auth file exists at $AUTH_FILE; keeping it (--reauth to refresh)"
fi
jq -e '.jwt and .api_key' "$AUTH_FILE" >/dev/null || fail "auth file $AUTH_FILE is missing jwt/api_key"

if [ "$SEED" = 1 ]; then
  step "seeding predefined profiles"
  ./testing/seed-profiles/seed-profiles.sh || fail "seed-profiles.sh"
fi

if [ "$FIXTURE" = 1 ]; then
  step "importing store-analytics fixture"
  ./testing/store-analytics-fixture/seed.sh || fail "store-analytics-fixture/seed.sh"
fi

step "endpoint evidence"
curl -fsS -o /dev/null -w "GET $APP_URL -> %{http_code}\n" "$APP_URL" || fail "app endpoint not answering at $APP_URL"

LOGIN_URL="$APP_URL/auth/dev-login?user_id=store-analytics&redirect_to=/"

if [ "$DEMO" = 1 ]; then
  step "demo screenshot (headless chromium)"
  SHOT="/tmp/cobb-demo-$(date +%s).png"
  CHROME=$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)
  if [ -n "$CHROME" ]; then
    "$CHROME" --headless --disable-gpu --window-size=1440,900 --screenshot="$SHOT" "$LOGIN_URL" 2>/dev/null \
      && echo "screenshot: $SHOT" || echo "WARN: screenshot failed; fall back to the browser skill" >&2
  else
    echo "WARN: no chromium found; fall back to the browser skill" >&2
  fi
fi

step "summary"
cat <<SUMMARY
stack:      up on process-compose port $PORT
app:        $APP_URL
login:      $LOGIN_URL
auth file:  $AUTH_FILE (COBB_JWT=jq -r .jwt, COBB_API_KEY=jq -r .api_key)
seeded:     profiles=$SEED fixture=$FIXTURE
SUMMARY
