#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fleet_bin=${FLEET_BIN:-$root/bin/fleet}
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin"
ssh_log=$test_dir/ssh.log
local_log=$test_dir/local.log
test_bash=${FLEET_TEST_BASH:-$(command -v bash)}

printf '#!%s\n' "$test_bash" >"$test_dir/bin/ssh"
cat >>"$test_dir/bin/ssh" <<'EOF'
set -u

host=""
remote=""
{
  printf 'ssh-argv'
  for arg in "$@"; do
    printf '\t%s' "$arg"
  done
  printf '\n'
} >>"$FLEET_TEST_SSH_LOG"

while (($#)); do
  case "$1" in
  -o)
    shift 2
    ;;
  *)
    host=$1
    shift
    remote=${1:-}
    break
    ;;
  esac
done

if [[ $remote == true ]]; then
  printf 'probe\t%s\n' "$host" >>"$FLEET_TEST_SSH_LOG"
  case ",${FLEET_TEST_UNAVAILABLE:-}," in
  *",$host,"*) exit 255 ;;
  esac
  exit 0
fi

printf 'dispatch\t%s\t%s\n' "$host" "$remote" >>"$FLEET_TEST_SSH_LOG"
case ",${FLEET_TEST_COMMAND_FAILURES:-}," in
*",$host,"*) exit 7 ;;
esac
EOF
chmod +x "$test_dir/bin/ssh"

printf '#!%s\n' "$test_bash" >"$test_dir/bin/fleet-test-caller"
cat >>"$test_dir/bin/fleet-test-caller" <<'EOF'
set -u
{
  printf 'local-dispatch'
  for arg in "$@"; do
    printf '\t%s' "$arg"
  done
  printf '\n'
} >>"$FLEET_TEST_LOCAL_LOG"
EOF
chmod +x "$test_dir/bin/fleet-test-caller"

printf '#!%s\n' "$test_bash" >"$test_dir/bin/hostname"
cat >>"$test_dir/bin/hostname" <<'EOF'
set -u
printf '%s\n' "$FLEET_TEST_HOSTNAME"
EOF
chmod +x "$test_dir/bin/hostname"

printf '#!%s\n' "$test_bash" >"$test_dir/bin/nix"
cat >>"$test_dir/bin/nix" <<'EOF'
set -u
printf '%s\n' "$*" >>"$FLEET_TEST_NIX_LOG"
printf '%s\n' "$FLEET_TEST_NIX_INVENTORY"
EOF
chmod +x "$test_dir/bin/nix"

export PATH="$test_dir/bin:$PATH"
export FLEET_TEST_SSH_LOG=$ssh_log
export FLEET_TEST_LOCAL_LOG=$local_log
export FLEET_TEST_NIX_LOG=$test_dir/nix.log
export FLEET_TEST_NIX_INVENTORY='{"schemaVersion":1,"hosts":[{"name":"zeta"},{"name":"beta"},{"name":"alpha"}]}'
export FLEET_TEST_HOSTNAME=controller
export FLEET_TEST_UNAVAILABLE=
export FLEET_TEST_COMMAND_FAILURES=
mkdir -p "$test_dir/repo"
touch "$test_dir/repo/flake.nix"
export FLEET_FLAKE=$test_dir/repo
flake_path=$(cd "$FLEET_FLAKE" && pwd -P)
literal_home=\$HOME

last_output=""
last_status=0

invoke() {
  if last_output=$("$test_bash" "$fleet_bin" "$@" 2>&1); then
    last_status=0
  else
    last_status=$?
  fi
}

assert_status() {
  local expected=$1 label=$2
  if [[ $last_status -ne $expected ]]; then
    printf 'FAIL %s: expected status %s, got %s\n%s\n' "$label" "$expected" "$last_status" "$last_output" >&2
    exit 1
  fi
}

assert_eq() {
  local expected=$1 actual=$2 label=$3
  if [[ $actual != "$expected" ]]; then
    printf 'FAIL %s\nexpected: <%s>\nactual:   <%s>\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_contains() {
  local needle=$1 haystack=$2 label=$3
  if [[ $haystack != *"$needle"* ]]; then
    printf 'FAIL %s: missing <%s>\n%s\n' "$label" "$needle" "$haystack" >&2
    exit 1
  fi
}

assert_empty_log() {
  local path=$1 label=$2
  if [[ -s $path ]]; then
    printf 'FAIL %s: log is not empty\n' "$label" >&2
    cat "$path" >&2
    exit 1
  fi
}

reset_execution_logs() {
  : >"$ssh_log"
  : >"$local_log"
}

invoke list
assert_status 0 "list"
assert_eq $'alpha\tdeclared\nbeta\tdeclared\ncontroller\tavailable\nzeta\tdeclared' "$last_output" "sorted list and local detection"

invoke list --json
assert_status 0 "list json"
assert_eq '["alpha","beta","controller","zeta"]' "$(jq -c '[.hosts[].host]' <<<"$last_output")" "json sorting"
assert_eq 'local' "$(jq -r '.hosts[] | select(.host == "controller") | .transport' <<<"$last_output")" "json local transport"

reset_execution_logs
export FLEET_TEST_HOSTNAME=beta
invoke list
assert_status 2 "local alias collision"
assert_contains "local host name collides with an SSH alias: beta" "$last_output" "local alias collision message"
assert_empty_log "$ssh_log" "local alias collision ssh"
export FLEET_TEST_HOSTNAME=controller

reset_execution_logs
export FLEET_TEST_UNAVAILABLE=alpha
invoke check --json
assert_status 1 "check unavailable"
assert_eq '["alpha:unavailable","beta:available","controller:available","zeta:available"]' "$(jq -c '[.hosts[] | "\(.host):\(.status)"]' <<<"$last_output")" "check continuation and sorting"
assert_eq $'probe\talpha\nprobe\tbeta\nprobe\tzeta' "$(grep '^probe' "$ssh_log")" "check probes after failure"

reset_execution_logs
invoke run --json alpha zeta -- does-not-exist "x y"
assert_status 0 "default dry-run"
assert_eq '["alpha:planned","zeta:planned"]' "$(jq -c '[.hosts[] | "\(.host):\(.status)"]' <<<"$last_output")" "dry-run plan"
assert_eq '["does-not-exist","x y"]' "$(jq -c '.hosts[0].command' <<<"$last_output")" "dry-run command argv"
assert_empty_log "$ssh_log" "dry-run ssh"
assert_empty_log "$local_log" "dry-run local command"

reset_execution_logs
invoke run --dry-run --json available -- fleet-test-caller
assert_status 0 "available dry-run"
assert_eq '["alpha:unavailable","beta:planned","controller:planned","zeta:planned"]' "$(jq -c '[.hosts[] | "\(.host):\(.status)"]' <<<"$last_output")" "available dry-run plan"
assert_eq 0 "$(awk -F '\t' '$1 == "dispatch" {count++} END{print count+0}' "$ssh_log")" "available dry-run dispatch count"
assert_empty_log "$local_log" "available dry-run local command"

reset_execution_logs
invoke run --execute --json all -- does-not-exist
assert_status 1 "strict preflight"
assert_eq '["alpha:unavailable","beta:available","controller:available","zeta:available"]' "$(jq -c '[.hosts[] | "\(.host):\(.status)"]' <<<"$last_output")" "strict preflight report"
assert_eq $'probe\talpha\nprobe\tbeta\nprobe\tzeta' "$(grep '^probe' "$ssh_log")" "strict preflight probes every remote"
assert_eq 0 "$(awk -F '\t' '$1 == "dispatch" {count++} END{print count+0}' "$ssh_log")" "strict preflight dispatch count"
assert_empty_log "$local_log" "strict preflight local dispatch"

reset_execution_logs
invoke run --execute --json available -- fleet-test-caller "a b" "x'y" "$literal_home" ''
assert_status 0 "available execution"
assert_eq '["alpha:unavailable","beta:ok","controller:ok","zeta:ok"]' "$(jq -c '[.hosts[] | "\(.host):\(.status)"]' <<<"$last_output")" "available subset results"
assert_eq $'local-dispatch\ta b\tx\x27y\t$HOME\t' "$(cat "$local_log")" "local argv preservation"
assert_eq 0 "$(awk -F '\t' '$1 == "dispatch" && $2 == "alpha" {count++} END{print count+0}' "$ssh_log")" "unavailable host dispatch count"
assert_eq 1 "$(awk -F '\t' '$1 == "dispatch" && $2 == "zeta" {count++} END{print count+0}' "$ssh_log")" "available remote dispatch count"

reset_execution_logs
invoke check mystery
assert_status 2 "unknown target"
assert_contains "unknown target: mystery" "$last_output" "unknown target message"
assert_empty_log "$ssh_log" "unknown target ssh"

reset_execution_logs
export FLEET_TEST_UNAVAILABLE=
invoke run --execute --json zeta --timeout 9 -- printf '%s\n' "a b" "x'y" "$literal_home" ''
assert_status 0 "quoted remote run"
for option in \
  BatchMode=yes \
  PasswordAuthentication=no \
  KbdInteractiveAuthentication=no \
  NumberOfPasswordPrompts=0 \
  ConnectionAttempts=1 \
  ConnectTimeout=9 \
  StrictHostKeyChecking=yes \
  RequestTTY=no; do
  assert_contains "$option" "$(grep '^ssh-argv' "$ssh_log")" "ssh option $option"
done
expected_remote=$'dispatch\tzeta\t\x27printf\x27 \x27%s\\n\x27 \x27a b\x27 \x27x\x27\\\x27\x27y\x27 \x27$HOME\x27 \x27\x27'
assert_eq "$expected_remote" "$(grep '^dispatch' "$ssh_log")" "POSIX remote argv quoting"

reset_execution_logs
export FLEET_TEST_COMMAND_FAILURES=alpha
invoke run --execute --json alpha zeta -- printf "done"
assert_status 1 "exit aggregation"
assert_eq '["alpha:failed","zeta:ok"]' "$(jq -c '[.hosts[] | "\(.host):\(.status)"]' <<<"$last_output")" "aggregated command statuses"
assert_eq $'dispatch\talpha\ndispatch\tzeta' "$(grep '^dispatch' "$ssh_log" | cut -f1-2)" "dispatch continues after command failure"
export FLEET_TEST_COMMAND_FAILURES=

reset_execution_logs
invoke run --execute -- printf nope
assert_status 2 "missing target"
assert_contains "at least one target is required" "$last_output" "missing target message"
assert_empty_log "$ssh_log" "missing target ssh"

invoke run zeta printf nope
assert_status 2 "missing separator"
assert_contains "run requires -- before the command" "$last_output" "missing separator message"

invoke run zeta --
assert_status 2 "missing command"
assert_contains "run requires a command" "$last_output" "missing command message"

reset_execution_logs
invoke run --dry-run --execute zeta -- printf nope
assert_status 2 "conflicting modes"
assert_contains "choose either --dry-run or --execute" "$last_output" "conflicting mode message"
assert_empty_log "$ssh_log" "conflicting mode ssh"

reset_execution_logs
invoke check zeta --timeout 0
assert_status 2 "invalid timeout"
assert_contains "timeout must be an integer from 1 to 60" "$last_output" "invalid timeout message"
assert_empty_log "$ssh_log" "invalid timeout ssh"

invoke check zeta --timeout 18446744073709551616
assert_status 2 "overflow timeout"
assert_contains "timeout must be an integer from 1 to 60" "$last_output" "overflow timeout message"
assert_empty_log "$ssh_log" "overflow timeout ssh"

reset_execution_logs
export FLEET_TEST_NIX_INVENTORY='{"schemaVersion":2,"hosts":[]}'
invoke list
assert_status 2 "schema version"
assert_contains "invalid fleet inventory" "$last_output" "schema version message"
assert_empty_log "$ssh_log" "invalid inventory ssh"
export FLEET_TEST_NIX_INVENTORY='{"schemaVersion":1,"hosts":[]}'
invoke list --json
assert_status 0 "local-only inventory"
assert_eq '["controller"]' "$(jq -c '[.hosts[].host]' <<<"$last_output")" "local-only membership"

export FLEET_TEST_NIX_INVENTORY='{"schemaVersion":1,"hosts":[{"name":"remote-from-flake"}]}'
: >"$FLEET_TEST_NIX_LOG"
invoke list --json
assert_status 0 "live flake inventory"
assert_eq '["controller","remote-from-flake"]' "$(jq -c '[.hosts[].host]' <<<"$last_output")" "live flake members"
assert_eq "eval --json --no-write-lock-file $flake_path#fleetInventory" "$(cat "$FLEET_TEST_NIX_LOG")" "live flake evaluation"

printf 'fleet tests passed\n'
