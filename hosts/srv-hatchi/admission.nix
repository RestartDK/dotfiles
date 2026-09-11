{ pkgs, units }:
pkgs.writeShellApplication {
  name = "hatchi-check-admission";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.jq
    pkgs.util-linux
  ];
  text = ''
    receipt=/var/lib/hatchi/admission.json
    test -f "$receipt"
    test ! -L "$receipt"
    test "$(stat -c %u "$receipt")" = 0
    test "$(stat -c %a "$receipt")" = 600
    test ! -L /var/lib/hatchi
    test "$(stat -c %u /var/lib/hatchi)" = 0
    mode=$(stat -c %a /var/lib/hatchi)
    (( (8#$mode & 8#022) == 0 ))
    mountpoint -q /srv/media
    identity=$(findmnt --json --mountpoint /srv/media --nofsroot --output SOURCE,FSTYPE,FSROOT |
      jq -ce '.filesystems | select(length == 1) | .[0] | {source, fsType: .fstype, root: .fsroot}')
    jq -es --arg machineId "$(</etc/machine-id)" --argjson mediaIdentity "$identity" \
      --argjson units ${pkgs.lib.escapeShellArg (builtins.toJSON units)} \
      -f ${./admission.jq} "$receipt" >/dev/null
  '';
}
