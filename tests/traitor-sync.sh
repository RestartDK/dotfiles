#!/usr/bin/env bash
set -euo pipefail

TRAITOR=${TRAITOR:-"$PWD/bin/traitor"}
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/traitor-sync-tests.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT

git_quiet() {
  git "$@" >/dev/null 2>&1
}

create_fixture() {
  local root="$TEST_ROOT/$1"
  mkdir -p "$root"
  git_quiet init --bare "$root/origin.git"
  git_quiet clone "$root/origin.git" "$root/seed"
  git -C "$root/seed" config user.name Test
  git -C "$root/seed" config user.email test@example.com
  printf '{}\n' >"$root/seed/flake.nix"
  printf 'base\n' >"$root/seed/shared.txt"
  git_quiet -C "$root/seed" add .
  git_quiet -C "$root/seed" commit -m base
  git_quiet -C "$root/seed" branch -M main
  git_quiet -C "$root/seed" push -u origin main
  git --git-dir="$root/origin.git" symbolic-ref HEAD refs/heads/main
  git_quiet clone "$root/origin.git" "$root/machine"
  git -C "$root/machine" config user.name Test
  git -C "$root/machine" config user.email test@example.com
  printf '%s\n' "$root"
}

push_remote_change() {
  local root=$1 path=$2 content=$3
  printf '%s\n' "$content" >"$root/seed/$path"
  git_quiet -C "$root/seed" add "$path"
  git_quiet -C "$root/seed" commit -m "remote $path"
  git_quiet -C "$root/seed" push
}

run_sync() {
  local root=$1
  shift
  FLAKE_DIR="$root/machine" bash "$TRAITOR" sync "$@"
}

assert_up_to_date_preserves_dirty_checkout() {
  local root
  root=$(create_fixture up-to-date)
  printf 'local\n' >"$root/machine/local.txt"
  local old_head old_status
  old_head=$(git -C "$root/machine" rev-parse HEAD)
  old_status=$(git -C "$root/machine" status --porcelain)
  run_sync "$root" >/dev/null
  test "$(git -C "$root/machine" rev-parse HEAD)" = "$old_head"
  test "$(git -C "$root/machine" status --porcelain)" = "$old_status"
}

assert_clean_sync() {
  local root
  root=$(create_fixture clean)
  push_remote_change "$root" remote.txt remote
  run_sync "$root" >/dev/null
  test "$(git -C "$root/machine" rev-parse HEAD)" = "$(git -C "$root/seed" rev-parse HEAD)"
  test "$(<"$root/machine/remote.txt")" = remote
}

assert_dirty_sync() {
  local root
  root=$(create_fixture dirty)
  printf 'local\n' >"$root/machine/local.txt"
  printf 'staged\n' >"$root/machine/staged.txt"
  printf 'changed locally\n' >"$root/machine/shared.txt"
  git_quiet -C "$root/machine" add staged.txt
  push_remote_change "$root" remote.txt remote
  run_sync "$root" >/dev/null
  test "$(<"$root/machine/local.txt")" = local
  test "$(<"$root/machine/staged.txt")" = staged
  test "$(<"$root/machine/shared.txt")" = 'changed locally'
  test "$(<"$root/machine/remote.txt")" = remote
  test "$(git -C "$root/machine" status --porcelain | wc -l | tr -d ' ')" = 3
  if git -C "$root/machine" diff --cached --quiet -- staged.txt; then
    return 1
  fi
  test -z "$(git -C "$root/machine" stash list)"
}

assert_diverged_sync() {
  local root
  root=$(create_fixture diverged)
  printf 'local commit\n' >"$root/machine/local.txt"
  git_quiet -C "$root/machine" add local.txt
  git_quiet -C "$root/machine" commit -m local
  local old_local
  old_local=$(git -C "$root/machine" rev-parse HEAD)
  push_remote_change "$root" remote.txt remote
  local remote_head
  remote_head=$(git -C "$root/seed" rev-parse HEAD)
  run_sync "$root" >/dev/null
  git_quiet -C "$root/machine" merge-base --is-ancestor "$remote_head" HEAD
  test "$(git -C "$root/machine" rev-parse HEAD)" != "$old_local"
  test "$(<"$root/machine/local.txt")" = 'local commit'
}

assert_conflict_restores_checkout() {
  local root
  root=$(create_fixture conflict)
  printf 'local dirty\n' >"$root/machine/shared.txt"
  push_remote_change "$root" shared.txt 'remote change'
  local old_head old_status output status=0
  old_head=$(git -C "$root/machine" rev-parse HEAD)
  old_status=$(git -C "$root/machine" status --porcelain)
  output=$(run_sync "$root" 2>&1) || status=$?
  test "$status" = 1
  test "$(git -C "$root/machine" rev-parse HEAD)" = "$old_head"
  test "$(git -C "$root/machine" status --porcelain)" = "$old_status"
  test "$(<"$root/machine/shared.txt")" = 'local dirty'
  test -z "$(git -C "$root/machine" diff --name-only --diff-filter=U)"
  grep -F "local changes conflict with 'origin/main'; checkout unchanged" <<<"$output"
}

assert_commit_conflict_restores_checkout() {
  local root
  root=$(create_fixture commit-conflict)
  printf 'local commit\n' >"$root/machine/shared.txt"
  git_quiet -C "$root/machine" add shared.txt
  git_quiet -C "$root/machine" commit -m local
  printf 'dirty\n' >"$root/machine/local.txt"
  push_remote_change "$root" shared.txt 'remote change'
  local old_head old_status output status=0
  old_head=$(git -C "$root/machine" rev-parse HEAD)
  old_status=$(git -C "$root/machine" status --porcelain)
  output=$(run_sync "$root" 2>&1) || status=$?
  test "$status" = 1
  test "$(git -C "$root/machine" rev-parse HEAD)" = "$old_head"
  test "$(git -C "$root/machine" status --porcelain)" = "$old_status"
  test "$(<"$root/machine/shared.txt")" = 'local commit'
  test "$(<"$root/machine/local.txt")" = dirty
  test -z "$(git -C "$root/machine" diff --name-only --diff-filter=U)"
  grep -F "conflicts with 'origin/main'; checkout unchanged" <<<"$output"
}

assert_expected_revision_guard() {
  local root
  root=$(create_fixture expected)
  local old_head output status=0
  old_head=$(git -C "$root/machine" rev-parse HEAD)
  push_remote_change "$root" remote.txt remote
  output=$(run_sync "$root" --expect "$old_head" 2>&1) || status=$?
  test "$status" = 1
  test "$(git -C "$root/machine" rev-parse HEAD)" = "$old_head"
  grep -F "expected $old_head" <<<"$output"
}

assert_offline_preserves_checkout() {
  local root
  root=$(create_fixture offline)
  printf 'local dirty\n' >"$root/machine/shared.txt"
  local old_head old_status output status=0
  old_head=$(git -C "$root/machine" rev-parse HEAD)
  old_status=$(git -C "$root/machine" status --porcelain)
  mv "$root/origin.git" "$root/origin.offline"
  output=$(run_sync "$root" 2>&1) || status=$?
  test "$status" = 1
  test "$(git -C "$root/machine" rev-parse HEAD)" = "$old_head"
  test "$(git -C "$root/machine" status --porcelain)" = "$old_status"
  grep -F "checkout unchanged" <<<"$output"
}

assert_sync_locking() {
  local root
  root=$(create_fixture locking)
  local lock_path="$root/machine/.git/traitor-sync.lock" output status=0
  ln -s "$$" "$lock_path"
  output=$(run_sync "$root" 2>&1) || status=$?
  test "$status" = 1
  test "$(readlink "$lock_path")" = "$$"
  grep -F 'another sync is already running' <<<"$output"
  rm "$lock_path"

  ln -s 99999999 "$lock_path"
  run_sync "$root" >/dev/null
  test ! -L "$lock_path"
}

assert_invalid_args_fail() {
  local root
  root=$(create_fixture invalid-args)
  local args output status
  local -a argv
  for args in '--bad' '--expect' '--expect HEAD extra'; do
    status=0
    read -r -a argv <<<"$args"
    output=$(run_sync "$root" "${argv[@]}" 2>&1) || status=$?
    test "$status" = 2
    grep -F 'sync accepts only optional --expect REV' <<<"$output"
  done
}

assert_no_upstream_fails() {
  local root
  root=$(create_fixture no-upstream)
  git -C "$root/machine" switch --detach >/dev/null 2>&1
  local output status=0
  output=$(run_sync "$root" 2>&1) || status=$?
  test "$status" = 1
  grep -F 'sync refuses a detached HEAD' <<<"$output"
}

assert_up_to_date_preserves_dirty_checkout
assert_clean_sync
assert_dirty_sync
assert_diverged_sync
assert_conflict_restores_checkout
assert_commit_conflict_restores_checkout
assert_expected_revision_guard
assert_offline_preserves_checkout
assert_sync_locking
assert_invalid_args_fail
assert_no_upstream_fails
