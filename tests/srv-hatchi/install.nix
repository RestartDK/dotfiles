{ inputs, ... }:
let
  inventory = builtins.fromJSON (builtins.readFile ./inventory.json);
  applicationUnits = map (entry: entry.unit) (builtins.filter (entry: entry.unit != null) inventory);
in
{
  imports = [
    inputs.disko.nixosModules.disko
    (import ../../hosts/srv-hatchi/disk-layout.nix {
      systemDisk = "/dev/vda";
      dataDisk = "/dev/vdb";
    })
    ../../hosts/srv-hatchi/bootstrap.nix
  ];
  disko.tests = {
    extraChecks = ''
      machine.succeed("test $(hostname) = srv-hatchi")
      machine.wait_for_unit("sshd.service")
      for unit in ${builtins.toJSON applicationUnits}:
          assert machine.succeed(f"systemctl show {unit}.service -p LoadState --value").strip() == "not-found"
      machine.succeed("ip netns add bootstrap-client")
      try:
          machine.succeed("ip link add bootstrap-host type veth peer name bootstrap-peer")
          machine.succeed("ip link set bootstrap-peer netns bootstrap-client")
          machine.succeed("ip address add 192.0.2.1/30 dev bootstrap-host; ip link set bootstrap-host up")
          machine.succeed("ip -n bootstrap-client address add 192.0.2.2/30 dev bootstrap-peer; ip -n bootstrap-client link set bootstrap-peer up")
          machine.wait_until_succeeds("ip netns exec bootstrap-client ssh-keyscan -T 3 192.0.2.1 2>/dev/null | grep -q ssh-ed25519")
      finally:
          machine.succeed("ip netns delete bootstrap-client")
      machine.succeed("findmnt -n -t ext4 /")
      machine.succeed("findmnt -n -t ext4 /srv")
      machine.succeed("findmnt -n -t vfat /boot")
      machine.fail("test -e /var/lib/nextcloud/config/config.php")
    '';
  };
}
