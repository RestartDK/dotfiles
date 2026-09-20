#!/usr/bin/env bash
set -euo pipefail

manifest=$1
age_key=$2
secrets_file=$3

for file in "$age_key" "$secrets_file"; do
  if [[ ! -s $file ]]; then
    printf 'Hatchi secret provisioning is incomplete: %s is missing or empty\n' "$file" >&2
    exit 1
  fi
done

sops-install-secrets -check-mode=sopsfile "$manifest"
SOPS_AGE_KEY_FILE="$age_key" sops decrypt --output /dev/null "$secrets_file"
