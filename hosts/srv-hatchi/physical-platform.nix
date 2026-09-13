{
  inputs,
  storage,
}:
{ lib, ... }:
assert lib.assertMsg (storage != null) "Hatchi physical commissioning requires storage settings";
assert lib.assertMsg (
  builtins.isAttrs storage && storage ? systemDisk && storage ? dataDisk
) "Hatchi physical commissioning requires systemDisk and dataDisk";
assert lib.assertMsg (
  storage.systemDisk != storage.dataDisk
) "Hatchi systemDisk and dataDisk must identify different disks";
assert lib.assertMsg (lib.hasPrefix "/dev/disk/by-id/" storage.systemDisk)
  "Hatchi systemDisk must use a stable /dev/disk/by-id path";
assert lib.assertMsg (lib.hasPrefix "/dev/disk/by-id/" storage.dataDisk)
  "Hatchi dataDisk must use a stable /dev/disk/by-id path";
{
  imports = [
    inputs.disko.nixosModules.disko
    (import ./disk-layout.nix storage)
  ];
}
