{
  dataDisk,
  systemDisk,
}:
{ lib, ... }:
assert lib.assertMsg (
  systemDisk != dataDisk
) "Hatchi systemDisk and dataDisk must identify different disks";
{
  boot.loader = {
    efi.canTouchEfiVariables = true;
    systemd-boot = {
      enable = true;
      configurationLimit = 10;
    };
  };
  disko.devices.disk = {
    system = {
      type = "disk";
      device = systemDisk;
      content = {
        type = "gpt";
        partitions = {
          ESP = {
            size = "1G";
            type = "EF00";
            content = {
              type = "filesystem";
              format = "vfat";
              mountpoint = "/boot";
              mountOptions = [ "umask=0077" ];
            };
          };
          root = {
            size = "100%";
            content = {
              type = "filesystem";
              format = "ext4";
              mountpoint = "/";
              mountOptions = [ "noatime" ];
            };
          };
        };
      };
    };
    data = {
      type = "disk";
      device = dataDisk;
      content = {
        type = "gpt";
        partitions.data = {
          size = "100%";
          content = {
            type = "filesystem";
            format = "ext4";
            mountpoint = "/srv";
            mountOptions = [
              "noatime"
              "nofail"
              "x-systemd.device-timeout=10s"
            ];
          };
        };
      };
    };
  };
}
