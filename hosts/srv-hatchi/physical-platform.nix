{
  inputs,
  storage ? {
    systemDisk = "/dev/disk/by-id/ata-LITEON_CV8-8E128-11_SATA_128GB_TW059X3VLOH008BC01G0";
    dataDisk = "/dev/disk/by-id/ata-ST1000LM049-2GH172_WGS2R867";
  },
}:
{ lib, ... }:
assert lib.assertMsg (storage != null) "Hatchi physical storage requires storage settings";
assert lib.assertMsg (
  builtins.isAttrs storage && storage ? systemDisk && storage ? dataDisk
) "Hatchi physical storage requires systemDisk and dataDisk";
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
    ./hardware-configuration.nix
  ];
}
