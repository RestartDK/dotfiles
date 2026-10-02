#!/usr/bin/env bash
# Fails while any delivered config still reads from the editable checkout
# instead of the Nix store. Host policy is not scanned, so a host may name a
# checkout for its own authoring sync unit. Each legacy reference needs a
# marker file under tests/live-checkout/legacy/, and the marker must be
# deleted with the reference, so the exception list can only shrink to zero.
set -euo pipefail

repo_root="$1"
legacy_dir="$repo_root/tests/live-checkout/legacy"

pattern='repoRoot|\.config/dotfiles'

flatten() { printf '%s' "${1//\//__}"; }

find_offenders() {
  grep -rl -E "$pattern" "$repo_root/modules" --exclude='*.md' 2>/dev/null || true
  grep -rl -E "$pattern" "$repo_root/config" --exclude='*.md' \
    --exclude-dir=node_modules 2>/dev/null || true
}

status=0
offenders=()
while read -r file; do
  [ -n "$file" ] || continue
  rel="${file#"$repo_root"/}"
  offenders+=("$rel")
  marker="$legacy_dir/$(flatten "$rel")"
  if [ ! -e "$marker" ]; then
    printf 'unapproved live-checkout reference: %s\n' "$rel"
    grep -n -E "$pattern" "$file" | sed 's/^/    /'
    status=1
  fi
done < <(find_offenders | sort -u)

while read -r marker; do
  [ -n "$marker" ] || continue
  rel="$(basename "$marker")"
  rel="${rel//__//}"
  if [ ! -e "$repo_root/$rel" ]; then
    printf 'stale exception marker for a file that no longer exists: %s\n' "$rel"
    status=1
  elif ! printf '%s\n' "${offenders[@]}" | grep -qx "$rel"; then
    printf 'stale exception marker for a converted file: %s\n' "$rel"
    status=1
  fi
done < <(find "$legacy_dir" -type f 2>/dev/null | sort)

printf '%s live-checkout exceptions remain, target is 0\n' "$(find "$legacy_dir" -type f 2>/dev/null | wc -l | tr -d ' ')"
exit "$status"
