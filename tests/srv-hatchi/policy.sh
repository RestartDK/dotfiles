#!/usr/bin/env bash
set -euo pipefail

export HOME="$TMPDIR/home" FLAKE_DIR="$ROOT"
export NIX_CALLS="$TMPDIR/nix-calls" SSH_CALLS="$TMPDIR/ssh-calls" UPSTREAM_CALLS="$TMPDIR/upstream-calls"
mkdir -p "$HOME"
test -z "$(find "$ROOT/hosts/srv-hatchi" "$ROOT/tests/srv-hatchi" -name '*.py' -print)"
opnix secret -h >/dev/null 2>&1
export PATH="$NIX_STUB/bin:$SSH_STUB/bin:$PATH"
export SOPS_AGE_KEY_FILE="$ROOT/tests/srv-hatchi/fixtures/age-key.txt"
test "$(sops decrypt --extract '["glance-key"]' "$ROOT/tests/srv-hatchi/fixtures/synthetic-secrets.sops.yaml" | base64 --decode | wc -c)" -eq 64

invoke() {
  local expected=$1 status=0
  shift
  : >"$NIX_CALLS"
  : >"$SSH_CALLS"
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
reject install
reject install srv-hatchi
reject install srv-hatchi root@example.invalid
reject install srv-hatchi admin@example.invalid --confirm-destroy
reject install srv-hatchi root@example.invalid --confirm-destroy extra
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
invoke 1 install srv-hatchi root@example.invalid --confirm-destroy
printf '%s\n' eval --raw "$ROOT#hatchiCommissioning.state" >"$TMPDIR/expected"
diff -u "$TMPDIR/expected" "$NIX_CALLS"

install_origin="$TMPDIR/install-origin.git"
install_repo="$TMPDIR/install-repo"
git init --quiet --bare --initial-branch=main "$install_origin"
git init --quiet --initial-branch=main "$install_repo"
mkdir -p "$install_repo/hosts/srv-hatchi"
printf '{ }\n' >"$install_repo/flake.nix"
printf '{ ... }: { }\n' >"$install_repo/hosts/srv-hatchi/hardware-configuration.nix"
git -C "$install_repo" add .
git -C "$install_repo" -c user.name=Fixture -c user.email=fixture@example.invalid commit --quiet -m fixture
git -C "$install_repo" remote add origin "$install_origin"
git -C "$install_repo" push --quiet --set-upstream origin main
install_revision="$(git -C "$install_repo" rev-parse HEAD)"
: >"$NIX_CALLS"
: >"$SSH_CALLS"
NIX_EVAL_STATE=install-ready \
  NIX_SMART_HEALTH=passed \
  NIX_STUB_INSPECT_EXTRA_FILES="$TMPDIR/staged-revision" \
  FLAKE_DIR="$install_repo" \
  bash "$ROOT/bin/traitor" install srv-hatchi root@example.invalid --confirm-destroy >"$TMPDIR/response"
test "$(cat "$TMPDIR/staged-revision")" = "$install_revision"
test "$(grep -Fxc run "$NIX_CALLS")" -eq 1
grep -Fx "$install_repo#nixos-anywhere" "$NIX_CALLS"
grep -Eq '/home/dkumlin/\.config/dotfiles#srv-hatchi-bootstrap$' "$NIX_CALLS"
grep -Fx -- --target-host "$NIX_CALLS"
grep -Fx root@example.invalid "$NIX_CALLS"
grep -Fx -- --extra-files "$NIX_CALLS"
grep -Fx -- --chown "$NIX_CALLS"
grep -Fx /home/dkumlin/.config "$NIX_CALLS"
grep -Fx 1000:100 "$NIX_CALLS"
if grep -Fx -- --confirm-destroy "$NIX_CALLS" || grep -Fx -- --generate-hardware-config "$NIX_CALLS"; then
  echo "traitor forwarded an internal installation option" >&2
  exit 1
fi
grep -F "Installing revision $install_revision on root@example.invalid" "$TMPDIR/response"
grep -F "System disk: /dev/disk/by-id/fixture-system" "$TMPDIR/response"
grep -F "Data disk: /dev/disk/by-id/fixture-data" "$TMPDIR/response"
printf '%s\n' \
  -o \
  BatchMode=yes \
  root@example.invalid \
  'bash -s -- /dev/disk/by-id/fixture-system /dev/disk/by-id/fixture-data ' \
  >"$TMPDIR/expected"
diff -u "$TMPDIR/expected" "$SSH_CALLS"

: >"$NIX_CALLS"
: >"$SSH_CALLS"
status=0
SSH_STUB_STATUS=1 \
  NIX_EVAL_STATE=install-ready \
  NIX_SMART_HEALTH=passed \
  FLAKE_DIR="$install_repo" \
  bash "$ROOT/bin/traitor" install srv-hatchi root@example.invalid --confirm-destroy >"$TMPDIR/response" 2>&1 || status=$?
test "$status" -eq 1
if grep -Fx run "$NIX_CALLS"; then
  echo "traitor ran nixos-anywhere after the remote disk preflight failed" >&2
  exit 1
fi
grep -F "Hatchi disk preflight failed; installation denied" "$TMPDIR/response"

invoke 0 deploy srv-nana --dry-run
printf '%s\n' run "$ROOT#deploy-rs" -- "$ROOT#srv-nana" --dry-activate >"$TMPDIR/expected"
diff -u "$TMPDIR/expected" "$NIX_CALLS"
invoke 0 twin
printf '%s\n' run "$ROOT#home-manager" -- switch --flake "$ROOT#twin" -b hm-backup >"$TMPDIR/expected"
diff -u "$TMPDIR/expected" "$NIX_CALLS"
if grep 'nix run' "$ROOT/bin/traitor" | grep -Ev 'nix run (\.#|"[$]flake_dir#)' >/dev/null; then
  echo "traitor must run external tools through root flake outputs" >&2
  exit 1
fi
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

export XDG_RUNTIME_DIR="$TMPDIR"
mkdir -p "$TMPDIR/secrets.d"
touch "$TMPDIR/secrets.d/sops-nix-secretfs"
fixture="$TMPDIR/synthetic-secrets.sops.yaml"
install -m600 "$ROOT/tests/srv-hatchi/fixtures/synthetic-secrets.sops.yaml" "$fixture"
jq --arg tmp "$TMPDIR" --arg fixture "$fixture" --arg key "$SOPS_AGE_KEY_FILE" '
  .userMode = true | .ageKeyFile = $key | .keepGenerations = 2 |
  .secretsMountPoint = ($tmp + "/secrets.d") | .symlinkPath = ($tmp + "/secrets") |
  .secrets |= map(.sopsFile = $fixture | .path = ($tmp + "/secrets/" + .name)) |
  .templates |= map(.path = ($tmp + "/secrets/rendered/" + .name))
' "$SOPS_MANIFEST" >"$TMPDIR/manifest.json"
sops-install-secrets -ignore-passwd "$TMPDIR/manifest.json"
rendered="$TMPDIR/secrets/rendered"
config="$TMPDIR/qBittorrent.conf"
for iteration in first second; do
  printf '[MigrationFixture]\nRetained=restored-setting\n' >"$config"
  install -m600 "$rendered/qBittorrent.conf" "$config"
  if grep -q 'restored-setting' "$config"; then
    echo 'Restored settings survived declarative replacement' >&2
    exit 1
  fi
  grep -Fx 'WebUI\LocalHostAuth=true' "$config"
  grep -Fx 'WebUI\Username=daniel' "$config"
  grep -Fx 'WebUI\Address=127.0.0.1' "$config"
  grep -Fx 'Accepted=true' "$config"
  grep -Fx "WebUI\Password_PBKDF2=$(sops decrypt --extract '["qbittorrent-password"]' "$fixture")" "$config" >/dev/null
  test "$(grep -c 'WebUI\\Password_PBKDF2=' "$config")" = 1
  test "$(stat -c %a "$config")" = 600
  cp "$config" "$TMPDIR/$iteration.conf"
done
diff -u "$TMPDIR/first.conf" "$TMPDIR/second.conf"
install -m600 "$rendered/AdGuardHome.yaml" "$TMPDIR/AdGuardHome.yaml"
test "$(stat -c %a "$TMPDIR/AdGuardHome.yaml")" = 600
yq -o=json '.' "$TMPDIR/AdGuardHome.yaml" | jq -e --rawfile password "$TMPDIR/secrets/adguard-password" '
  .dns.port == 53 and .http.address == "127.0.0.1:3000" and
  .users == [{name:"daniel",password:$password}]
' >/dev/null
for name in AdGuardHome.yaml qBittorrent.conf; do
  test "$(stat -Lc %a "$rendered/$name")" = 400
  if grep -Eq '<SOPS:|fixture-password' "$rendered/$name"; then
    echo 'Unrendered placeholder or plaintext password in configuration' >&2
    exit 1
  fi
  printf 'application-edited\n' >"$TMPDIR/$name"
  if grep -q application-edited "$rendered/$name"; then
    echo 'Application overwrote the SOPS template' >&2
    exit 1
  fi
done
salt=$(printf '%016d' 0 | base64 -w0)
key=$(printf '%064d' 1 | base64 -w0)
password="@ByteArray($salt:$key)"
sops set "$fixture" '["qbittorrent-password"]' "$(jq -cn --arg password "$password" '$password')"
sops set "$fixture" '["adguard-password"]' "\"\$2b\$10\$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\""
sops-install-secrets -ignore-passwd "$TMPDIR/manifest.json"
grep -Fx "WebUI\Password_PBKDF2=$password" "$rendered/qBittorrent.conf" >/dev/null
jq -e --rawfile password "$TMPDIR/secrets/adguard-password" '.users[0].password == $password' "$rendered/AdGuardHome.yaml" >/dev/null
cp "$rendered/qBittorrent.conf" "$TMPDIR/rotated.conf"
printf 'invalid ciphertext\n' >"$fixture"
if sops-install-secrets -ignore-passwd "$TMPDIR/manifest.json"; then
  echo 'Invalid ciphertext accepted' >&2
  exit 1
fi
diff -u "$TMPDIR/rotated.conf" "$rendered/qBittorrent.conf"

yq -o=json '.services | to_entries | map({"name": .key, "image": .value.image}) | sort_by(.name)' "$SOURCE_COMPOSE" >"$TMPDIR/observed-source.json"
jq '.services' "$ROOT/tests/srv-hatchi/source-manifest.json" >"$TMPDIR/expected-source.json"
diff -u "$TMPDIR/expected-source.json" "$TMPDIR/observed-source.json"
printf 'Exact-node CLI, VM-only entrypoint, runtime templates, and pinned inventory checks passed\n'
