#!/usr/bin/env bash
# Prints the provider/model a new Pi session boots with for a settings file.
# Needs live provider auth, so it is a diagnostic, not a flake check.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
settings=${1:-$root/config/pi/agent/settings.json}
if [[ ! -f $settings ]]; then
  printf 'no such settings file: %s\n' "$settings" >&2
  exit 2
fi

agent_dir=$(mktemp -d)
trap 'rm -rf "$agent_dir"' EXIT

for file in auth.json models.json models-store.json; do
  cp "$HOME/.pi/agent/$file" "$agent_dir/$file"
done
cp "$settings" "$agent_dir/settings.json"

model=$(
  PI_CODING_AGENT_DIR=$agent_dir PI_OFFLINE=1 \
    pi -p --mode json --no-session OK |
    jq -rs 'first(.[] | select(.type == "message_start" and .message.model) | "\(.message.provider)/\(.message.model)") // empty'
)

if [[ -z $model ]]; then
  printf 'pi resolved no model for %s\n' "$settings" >&2
  exit 1
fi

printf '%s\n' "$model"
