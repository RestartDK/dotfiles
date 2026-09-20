#!/usr/bin/env bash
set -euo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export HOME="$work/home"
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
export PI_OFFLINE=1 PI_TELEMETRY=0
unset OPENROUTER_API_KEY
mkdir -p "$PI_CODING_AGENT_DIR"
cd "$work"

secret="$HOME/.opnix-openrouter-api-key"
jq --arg source "$SECRET_PATH" --arg target "$secret" '
  .providers.openrouter.apiKey |= (split($source) | join($target))
' "$MODELS_FILE" >"$PI_CODING_AGENT_DIR/models.json"
jq -e --slurpfile base "$BASE_MODELS" '
  del(.providers.openrouter) == $base[0]
' "$PI_CODING_AGENT_DIR/models.json" >/dev/null
printf '%s\n' '{"anthropic":{"type":"api_key","key":"unrelated-fixture"}}' >"$PI_CODING_AGENT_DIR/auth.json"
cp "$PI_CODING_AGENT_DIR/auth.json" "$work/auth-before.json"

printf '%s\n' 'opnix-test-key-one' >"$secret"
chmod 0400 "$secret"
pi auth print-api-key --provider openrouter >"$work/actual"
cmp "$secret" "$work/actual"

chmod 0600 "$secret"
printf '%s\n' 'opnix-test-key-two' >"$secret"
chmod 0400 "$secret"
pi auth print-api-key --provider openrouter >"$work/actual"
cmp "$secret" "$work/actual"

export OPENROUTER_API_KEY=environment-fixture
pi auth print-api-key --provider openrouter >"$work/actual"
cmp "$secret" "$work/actual"
unset OPENROUTER_API_KEY

rm "$secret"
if pi auth print-api-key --provider openrouter >"$work/actual" 2>"$work/error"; then
  echo 'Pi accepted a missing secret file' >&2
  exit 1
fi
: >"$secret"
chmod 0400 "$secret"
if pi auth print-api-key --provider openrouter >"$work/actual" 2>"$work/error"; then
  echo 'Pi accepted an empty secret file' >&2
  exit 1
fi
cmp "$work/auth-before.json" "$PI_CODING_AGENT_DIR/auth.json"

printf '%s\n' 'PASS: Pi reads file-backed keys, sees rotation, preserves logins, and rejects missing or empty keys'
