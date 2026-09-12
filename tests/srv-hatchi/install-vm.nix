{
  pkgs,
  flake,
  anywhere,
}:
pkgs.writeShellApplication {
  name = "srv-hatchi-install-vm";
  text = ''
    if (($# != 0)); then
      echo "srv-hatchi-install-vm accepts no arguments" >&2
      exit 2
    fi
    exec ${pkgs.lib.getExe' anywhere "nixos-anywhere"} --flake ${pkgs.lib.escapeShellArg "${flake}#srv-hatchi-bootstrap"} --vm-test
  '';
}
