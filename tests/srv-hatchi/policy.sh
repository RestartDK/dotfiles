#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$TMPDIR/stubs" "$TMPDIR/credentials"
export HOME="$TMPDIR/home" FLAKE_DIR="$ROOT"
export NIX_CALLS="$TMPDIR/nix-calls" UPSTREAM_CALLS="$TMPDIR/upstream-calls"
mkdir -p "$HOME"
cat >"$TMPDIR/stubs/nix" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$NIX_CALLS"
if [[ $1 == eval ]]; then printf 'uncommissioned\n'; fi
SH
chmod +x "$TMPDIR/stubs/nix"
export PATH="$TMPDIR/stubs:$PATH"

invoke() {
  local expected=$1 status=0
  shift
  : >"$NIX_CALLS"
  bash "$ROOT/bin/traitor" "$@" >"$TMPDIR/response" 2>&1 || status=$?
  if [[ $status != "$expected" ]]; then
    printf 'Unexpected exit %s for %s\n' "$status" "$*" >&2
    cat "$TMPDIR/response" >&2
    exit 1
  fi
}

reject() {
  invoke 2 "$@"
  test ! -s "$NIX_CALLS"
}

reject deploy
reject deploy '*'
reject deploy srv-nana srv-hatchi
reject deploy srv-hatchi-bootstrap
reject deploy srv-nana --dry-run extra
reject verify
reject verify srv-nana install-vm
reject verify srv-hatchi --vm-test
for flag in --hostname=other --auto-rollback=false --targets=srv-nana --skip-checks -- --remote-build; do
  reject deploy srv-nana "$flag"
done
for kind in install-vm services-vm closures policy; do
  for flag in --target-host=root@example.invalid --store-paths --phases=disko --extra-files=/tmp --flake=other --option --; do
    reject verify srv-hatchi "$kind" "$flag"
  done
done
for flag in '' --dry-run; do
  flags=()
  if [[ -n $flag ]]; then flags+=("$flag"); fi
  invoke 1 deploy srv-hatchi "${flags[@]}"
  printf '%s\n' eval --raw "$ROOT#hatchiCommissioning.state" >"$TMPDIR/expected"
  diff -u "$TMPDIR/expected" "$NIX_CALLS"
done
invoke 0 deploy srv-nana --dry-run
printf '%s\n' run --inputs-from "$ROOT" deploy-rs -- "$ROOT#srv-nana" --dry-activate >"$TMPDIR/expected"
diff -u "$TMPDIR/expected" "$NIX_CALLS"
invoke 0 verify srv-hatchi install-vm
printf '%s\n' run "$ROOT#srv-hatchi-install-vm" >"$TMPDIR/expected"
diff -u "$TMPDIR/expected" "$NIX_CALLS"
invoke 0 verify srv-hatchi services-vm
printf '%s\n' build --no-link --print-build-logs "$ROOT#checks.x86_64-linux.srv-hatchi-services" >"$TMPDIR/expected"
diff -u "$TMPDIR/expected" "$NIX_CALLS"

for flag in root@example.invalid --target-host=root@example.invalid --store-paths --phases --phases=disko --extra-files --extra-files=/tmp --flake=other --vm-test -- --help; do
  : >"$UPSTREAM_CALLS"
  status=0
  "$INSTALL_VERIFIER" "$flag" >"$TMPDIR/response" 2>&1 || status=$?
  test "$status" = 2
  test ! -s "$UPSTREAM_CALLS"
done
for args in '--target-host root@example.invalid' '--store-paths /nix/store/destroy /nix/store/system' '--phases disko' '--extra-files /tmp'; do
  : >"$UPSTREAM_CALLS"
  read -r -a flags <<<"$args"
  status=0
  "$INSTALL_VERIFIER" "${flags[@]}" >"$TMPDIR/response" 2>&1 || status=$?
  test "$status" = 2
  test ! -s "$UPSTREAM_CALLS"
done
"$INSTALL_VERIFIER"
printf '%s\n' --flake "$ROOT#srv-hatchi-bootstrap" --vm-test >"$TMPDIR/expected"
diff -u "$TMPDIR/expected" "$UPSTREAM_CALLS"

receipt="$TMPDIR/receipt.json"
jq -n '{version:1, machineId:"fixture", mediaIdentity:{source:"fixture", fsType:"tmpfs", root:"/"}, services:{"nextcloud-setup":{state:"fresh", reviewDigest:("a" * 64)}}}' >"$receipt"
admit() {
  jq -es --arg machineId fixture --argjson mediaIdentity '{"source":"fixture","fsType":"tmpfs","root":"/"}' --argjson units '["nextcloud-setup"]' -f "$ROOT/hosts/srv-hatchi/admission.jq" "$1" >/dev/null
}
admit "$receipt"
jq '.services["nextcloud-setup"] += {state:"restored",backupDigest:("b" * 64),sourceVersion:"1",procedureVersion:"1"}' "$receipt" >"$TMPDIR/restored.json"
admit "$TMPDIR/restored.json"
for change in '.machineId="wrong"' '.services={}' '.mediaIdentity={}' '.version=0' '.services["nextcloud-setup"].state="restored"' '.services["nextcloud-setup"].reviewDigest=7' '.services["nextcloud-setup"].reviewDigest += "\n"' '.services["nextcloud-setup"].unexpected=true' '.services["nextcloud-setup"]=null' '.extra=true'; do
  jq "$change" "$receipt" >"$TMPDIR/invalid.json"
  if admit "$TMPDIR/invalid.json"; then
    echo "Invalid receipt accepted" >&2
    exit 1
  fi
done
for change in '.services["nextcloud-setup"].sourceVersion=""' '.services["nextcloud-setup"].backupDigest="bad"' '.services["nextcloud-setup"].procedureVersion=2'; do
  jq "$change" "$TMPDIR/restored.json" >"$TMPDIR/invalid.json"
  if admit "$TMPDIR/invalid.json"; then
    echo "Invalid restore accepted" >&2
    exit 1
  fi
done

export CREDENTIALS_DIRECTORY="$TMPDIR/credentials"
config="$TMPDIR/qBittorrent.conf"
printf '[Preferences]\nWebUI\\Username=restored\nWebUI\\LocalHostAuth=false\nGeneral\\Locale=sv\n[BitTorrent]\nSession\\GlobalMaxSeedingMinutes=37\n' >"$config"
salt=$(printf '%016d' 0 | base64 -w0)
key=$(printf '%064d' 0 | base64 -w0)
printf '@ByteArray(%s:%s)\n' "$salt" "$key" >"$CREDENTIALS_DIRECTORY/password"
for iteration in first second; do
  "$QBITTORRENT_RENDERER" "$config"
  grep -Fx 'General\Locale=sv' "$config"
  grep -Fx 'Session\GlobalMaxSeedingMinutes=37' "$config"
  grep -Fx 'WebUI\LocalHostAuth=true' "$config"
  grep -Fx 'WebUI\Username=daniel' "$config"
  test "$(grep -c 'WebUI\\Password_PBKDF2=' "$config")" = 1
  test "$(stat -c %a "$config")" = 600
  cp "$config" "$TMPDIR/$iteration.conf"
done
diff -u "$TMPDIR/first.conf" "$TMPDIR/second.conf"
key=$(printf '%064d' 1 | base64 -w0)
printf '@ByteArray(%s:%s)\n' "$salt" "$key" >"$CREDENTIALS_DIRECTORY/password"
"$QBITTORRENT_RENDERER" "$config"
grep -Fx "WebUI\Password_PBKDF2=@ByteArray($salt:$key)" "$config" >/dev/null
cp "$config" "$TMPDIR/rotated.conf"
for password in invalid '@ByteArray(YQ==:Yg==)' '@ByteArray(bad!:bad!)'; do
  printf %s "$password" >"$CREDENTIALS_DIRECTORY/password"
  if "$QBITTORRENT_RENDERER" "$config"; then
    echo "Invalid password accepted" >&2
    exit 1
  fi
  diff -u "$TMPDIR/rotated.conf" "$config"
done
printf '@ByteArray(%s:%s)\n' "$salt" "$key" >"$CREDENTIALS_DIRECTORY/password"
"$QBITTORRENT_RENDERER" "$TMPDIR/fresh.conf"
grep -Fx 'Accepted=true' "$TMPDIR/fresh.conf"
grep -Fx 'WebUI\Address=127.0.0.1' "$TMPDIR/fresh.conf"

config="$TMPDIR/AdGuardHome.yaml"
printf '{"users":[],"dns":{"port":53}}' >"$config"
jq -n '{users:[{name:"fixture",password:("$2b$10$" + ("a" * 53))}]}' >"$CREDENTIALS_DIRECTORY/users"
"$ADGUARD_RENDERER" "$config"
test "$(stat -c %a "$config")" = 600
yq -o=json '.' "$config" | jq -e '.dns.port == 53 and .users[0].name == "fixture"' >/dev/null
cp "$config" "$TMPDIR/adguard-valid.yaml"
for users in '[]' '[{"name":"fixture","password":"plaintext"}]'; do
  jq -n --argjson users "$users" '{users:$users}' >"$CREDENTIALS_DIRECTORY/users"
  if "$ADGUARD_RENDERER" "$config"; then
    echo "Invalid users accepted" >&2
    exit 1
  fi
  diff -u "$TMPDIR/adguard-valid.yaml" "$config"
done

yq -o=json '.services | to_entries | map({"name": .key, "image": .value.image}) | sort_by(.name)' "$SOURCE_COMPOSE" >"$TMPDIR/observed-source.json"
jq '.services' "$ROOT/tests/srv-hatchi/source-manifest.json" >"$TMPDIR/expected-source.json"
diff -u "$TMPDIR/expected-source.json" "$TMPDIR/observed-source.json"
test -z "$(find "$ROOT/hosts/srv-hatchi" "$ROOT/tests/srv-hatchi" -name '*.py' -print)"
printf 'Exact-node CLI, VM-only entrypoint, admission, credential merge, and pinned inventory checks passed\n'
