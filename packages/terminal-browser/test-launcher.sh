#!/usr/bin/env bash
set -euo pipefail

source_dir="$1"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/netns" "$scratch/home" "$scratch/runtime" "$scratch/bin"
shell="$(command -v bash)"
printf '#!%s\nprintf "%%s\\n" Linux\n' "$shell" >"$scratch/bin/uname"
chmod +x "$scratch/bin/uname"
export PATH="$scratch/bin:$PATH"
touch "$scratch/current" "$scratch/other" "$scratch/helper-old" "$scratch/helper-new"
chmod +x "$scratch/helper-old" "$scratch/helper-new"
ln -s "$scratch/helper-old" "$scratch/run-dev-netns"
user="$(id -un)"
ln -s "$scratch/current" "$scratch/netns/dev-$user-test-current"
ln -s "$scratch/other" "$scratch/netns/dev-$user-test-other"

cat >"$scratch/backend" <<'BACKEND'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${XDG_RUNTIME_DIR-}" "${TERMINAL_BROWSER_NAMESPACE-}" "${TERMINAL_BROWSER_NAMESPACE_LAUNCHER-}" "$@"
BACKEND
sed -i "1c#!$shell" "$scratch/backend"
chmod +x "$scratch/backend"
sed -e "s|@browser@|$scratch/backend|g" \
  -e "s|/var/run/netns|$scratch/netns|g" \
  -e "s|/proc/self/ns/net|$scratch/current|g" \
  -e "s|/run/current-system/sw/bin/run-dev-netns|$scratch/run-dev-netns|g" \
  -e "s|/run/wrappers/bin/sudo|$scratch/backend|g" \
  -e "s|/run/user|$scratch/runtime|g" \
  "$source_dir/launcher.sh" >"$scratch/launcher"
sed -i "1c#!$shell" "$scratch/launcher"
chmod +x "$scratch/launcher"

HOME="$scratch/home" "$scratch/launcher" action -- 'a value with spaces' "single'quote" >"$scratch/output"
mapfile -t output <"$scratch/output"
[[ "${output[1]}" == "dev-$user-test-current" ]]
[[ "${output[3]}" == action && "${output[5]}" == 'a value with spaces' && "${output[6]}" == "single'quote" ]]
[[ "$(stat -c %a "${output[0]}")" == 700 ]]

HOME="$scratch/home" "$scratch/launcher" --namespace "dev-$user-test-other" open 'https://example.com/a b' >"$scratch/output"
mapfile -t output <"$scratch/output"
[[ "${output[3]}" == -n && "${output[4]}" == -E ]]
[[ "${output[5]}" == "$scratch/helper-old" && "${output[6]}" == "dev-$user-test-other" ]]
[[ "${output[7]}" == "$scratch/launcher" && "${output[9]}" == 'https://example.com/a b' ]]

ln -sfn "$scratch/helper-new" "$scratch/run-dev-netns"
HOME="$scratch/home" PI_NETNS_RUN_DEV_NETNS="$scratch/helper-old" "$scratch/launcher" --namespace "dev-$user-test-other" ls >"$scratch/output"
mapfile -t output <"$scratch/output"
[[ "${output[5]}" == "$scratch/helper-new" ]]

if "$scratch/launcher" --namespace dev-foreign-user open >"$scratch/output" 2>&1; then
  printf '%s\n' 'Foreign namespace was accepted' >&2
  exit 1
fi
if "$scratch/launcher" --namespace "dev-$user-test/../other" open >"$scratch/output" 2>&1; then
  printf '%s\n' 'Namespace path traversal was accepted' >&2
  exit 1
fi

mv "$scratch/netns/dev-$user-test-current" "$scratch/owned-link"
HOME="$scratch/home" XDG_RUNTIME_DIR=/existing TERMINAL_BROWSER_NAMESPACE=stale "$scratch/launcher" ls --all >"$scratch/output"
mapfile -t output <"$scratch/output"
[[ "${output[0]}" == /existing && -z "${output[1]}" && -z "${output[2]}" ]]
printf '%s\n' 'Namespace routing, argument quoting, private paths, host passthrough and security checks passed'
