#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
skills=${SKILLS_ROOT:-$root/config/agents/skills}
lock=${SKILLS_LOCK:-$root/config/agents/.skill-lock.json}
agents=${AGENTS_DIR:-$root/config/agents/agents}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

jq -e '.skills | type == "object"' "$lock" >/dev/null 2>&1 || fail "lock is not readable as a skill lock: $lock"

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

for name in dstack-agent comment-sicko; do
  [ -f "$agents/$name.md" ] && [ ! -L "$agents/$name.md" ] || fail "agent definition missing or symlinked: $agents/$name.md"
done
[ ! -d "$skills/dstack/agents" ] || fail "agent definitions belong in config/agents/agents"

mapfile -t vendored < <(jq -r '.skills | keys[]' "$lock")
for name in "${vendored[@]}"; do
  [ -f "$skills/$name/SKILL.md" ] || fail "lock lists $name, missing from $skills"
done

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

printf 'skills: %s vendored, %s authored, layout ok\n' "${#vendored[@]}" "$authored"
