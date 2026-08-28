#!/usr/bin/env bash
# Vendor dstack into a repo's .agents/skills/ so cloud agents (which only see
# the repo) get the full stack. Idempotent; reruns overwrite the vendored copy.
# usage: sync.sh <repo-root>
set -euo pipefail
REPO="${1:?usage: sync.sh <repo-root>}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -d "$REPO/.git" ] || [ -f "$REPO/.git" ] || {
  echo "FAIL: $REPO is not a git repo root" >&2
  exit 1
}
DEST="$REPO/.agents/skills/dstack"
mkdir -p "$DEST"
rsync -a --delete --exclude 'models.md' "$SRC/" "$DEST/"
echo "vendored $SRC -> $DEST (models.md excluded; personal model choices stay local)"
