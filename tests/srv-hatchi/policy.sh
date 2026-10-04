#!/usr/bin/env bash
set -euo pipefail

export HOME="$TMPDIR/home" FLAKE_DIR="$ROOT"
export NIX_CALLS="$TMPDIR/nix-calls" SSH_CALLS="$TMPDIR/ssh-calls"
mkdir -p "$HOME"
test -z "$(find "$ROOT/hosts/srv-hatchi" "$ROOT/tests/srv-hatchi" -name '*.py' -print)"
opnix secret -h >/dev/null 2>&1
export PATH="$NIX_STUB/bin:$SSH_STUB/bin:$PATH"

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
  test ! -s "$SSH_CALLS"
}

reject deploy
reject deploy '*'
reject deploy srv-nana srv-hatchi
reject deploy srv-nana --dry-run extra
reject install
reject install srv-hatchi
reject install srv-hatchi root@example.invalid
reject install srv-hatchi admin@example.invalid --confirm-destroy
reject install srv-hatchi root@example.invalid --confirm-destroy extra
reject verify
reject verify srv-nana services-vm
reject verify srv-hatchi --vm-test
for node in srv-nana srv-hatchi; do
  reject deploy "$node" --dry-run --dry-run
  reject deploy "$node" --remote-build --remote-build
  reject deploy "$node" --skip-checks --skip-checks
  reject deploy "$node" --remote-build true
  reject deploy "$node" --skip-checks true
  reject deploy "$node" --remote-build --dry-run extra
  for flag in --hostname=other --auto-rollback=false --targets=srv-nana --remote-build=true --; do
    reject deploy "$node" "$flag"
    reject deploy "$node" --remote-build "$flag"
  done
done
for kind in services-vm closures policy; do
  for flag in --target-host=root@example.invalid --store-paths --phases=disko --extra-files=/tmp --flake=other --option --; do
    reject verify srv-hatchi "$kind" "$flag"
  done
done
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
FLAKE_DIR="$install_repo" invoke 1 install srv-hatchi root@example.invalid --confirm-destroy
test ! -s "$NIX_CALLS"
test ! -s "$SSH_CALLS"
grep -F 'before installing Hatchi' "$TMPDIR/response"
bootstrap="$HOME/.local/state/hatchi-bootstrap/var/lib/opnix"
install -d -m700 "$bootstrap"
printf '%s' 'synthetic-opnix-token' >"$bootstrap/token"
chmod 600 "$bootstrap/token"
: >"$NIX_CALLS"
: >"$SSH_CALLS"
NIX_STUB_INSPECT_EXTRA_FILES="$TMPDIR/staged-revision" \
  FLAKE_DIR="$install_repo" \
  bash "$ROOT/bin/traitor" install srv-hatchi root@example.invalid --confirm-destroy >"$TMPDIR/response"
test "$(cat "$TMPDIR/staged-revision")" = "$install_revision"
test "$(grep -Fxc run "$NIX_CALLS")" -eq 1
grep -Fx "$install_repo#nixos-anywhere" "$NIX_CALLS"
grep -Eq '/home/dkumlin/\.config/dotfiles#srv-hatchi$' "$NIX_CALLS"
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
  FLAKE_DIR="$install_repo" \
  bash "$ROOT/bin/traitor" install srv-hatchi root@example.invalid --confirm-destroy >"$TMPDIR/response" 2>&1 || status=$?
test "$status" -eq 1
if grep -Fx run "$NIX_CALLS"; then
  echo "traitor ran nixos-anywhere after the remote disk preflight failed" >&2
  exit 1
fi
grep -F "Hatchi disk preflight failed; installation denied" "$TMPDIR/response"

for node in srv-nana srv-hatchi; do
  invoke 0 deploy "$node"
  printf '%s\n' run "$ROOT#deploy-rs" -- "$ROOT#$node" >"$TMPDIR/expected"
  diff -u "$TMPDIR/expected" "$NIX_CALLS"
  invoke 0 deploy "$node" --dry-run
  printf '%s\n' run "$ROOT#deploy-rs" -- "$ROOT#$node" --dry-activate >"$TMPDIR/expected"
  diff -u "$TMPDIR/expected" "$NIX_CALLS"
  invoke 0 deploy "$node" --remote-build
  printf '%s\n' run "$ROOT#deploy-rs" -- "$ROOT#$node" --remote-build >"$TMPDIR/expected"
  diff -u "$TMPDIR/expected" "$NIX_CALLS"
  invoke 0 deploy "$node" --skip-checks
  printf '%s\n' run "$ROOT#deploy-rs" -- "$ROOT#$node" --skip-checks >"$TMPDIR/expected"
  diff -u "$TMPDIR/expected" "$NIX_CALLS"
  invoke 0 deploy "$node" --remote-build --skip-checks
  printf '%s\n' run "$ROOT#deploy-rs" -- "$ROOT#$node" --remote-build --skip-checks >"$TMPDIR/expected"
  diff -u "$TMPDIR/expected" "$NIX_CALLS"
  invoke 0 deploy "$node" --remote-build --dry-run
  printf '%s\n' run "$ROOT#deploy-rs" -- "$ROOT#$node" --remote-build --dry-activate >"$TMPDIR/expected"
  diff -u "$TMPDIR/expected" "$NIX_CALLS"
  invoke 0 deploy "$node" --dry-run --remote-build
  printf '%s\n' run "$ROOT#deploy-rs" -- "$ROOT#$node" --dry-activate --remote-build >"$TMPDIR/expected"
  diff -u "$TMPDIR/expected" "$NIX_CALLS"
done
invoke 0 twin
printf '%s\n' run "$ROOT#home-manager" -- switch --flake "$ROOT#twin" -b hm-backup >"$TMPDIR/expected"
diff -u "$TMPDIR/expected" "$NIX_CALLS"
if grep 'nix run' "$ROOT/bin/traitor" | grep -Ev 'nix run (\.#|"[$]flake_dir#)' >/dev/null; then
  echo "traitor must run external tools through root flake outputs" >&2
  exit 1
fi
invoke 0 verify srv-hatchi services-vm
printf '%s\n' build --no-link --print-build-logs "$ROOT#checks.x86_64-linux.srv-hatchi-services" >"$TMPDIR/expected"
diff -u "$TMPDIR/expected" "$NIX_CALLS"
invoke 0 verify srv-hatchi closures
printf '%s\n' build --no-link --print-build-logs "$ROOT#nixosConfigurations.srv-hatchi.config.system.build.toplevel" >"$TMPDIR/expected"
diff -u "$TMPDIR/expected" "$NIX_CALLS"

printf 'Exact-node CLI, installer safeguards, and pinned inventory checks passed\n'
