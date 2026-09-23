#!/usr/bin/env bash
# Asserts the global skill root layout and the vendor lock agree.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
skills=${SKILLS_ROOT:-$root/config/agents/skills}
lock=${SKILLS_LOCK:-$root/config/agents/.skill-lock.json}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

while IFS= read -r file; do
  fail "$(basename "$file") is a file, skills live in directories"
done < <(find "$skills" -mindepth 1 -maxdepth 1 -type f)

while IFS= read -r dir; do
  name=$(basename "$dir")
  case $name in
  dstack | .system) continue ;;
  esac
  [ -f "$dir/SKILL.md" ] || fail "$name is neither the dstack bundle, .system, nor a skill"
done < <(find "$skills" -mindepth 1 -maxdepth 1 -type d)

[ -d "$skills/dstack/principles" ] || fail "dstack/principles is missing"
[ ! -d "$skills/dstack/agents" ] || fail "agent definitions belong in config/agents/agents"

while IFS= read -r name; do
  [ -f "$skills/$name/SKILL.md" ] || fail "lock lists $name, missing from $skills"
done < <(jq -r '.skills | keys[]' "$lock")

authored=0
for dir in "$skills"/*/; do
  name=$(basename "$dir")
  case $name in
  .system | dstack) continue ;;
  esac
  if ! jq -e --arg n "$name" '.skills[$n]' "$lock" >/dev/null; then
    authored=$((authored + 1))
  fi
done

printf 'skills: %s vendored, %s authored, layout ok\n' \
  "$(jq -r '.skills | length' "$lock")" "$authored"
