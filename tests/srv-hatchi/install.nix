{ inputs, ... }:
{
  imports = [
    inputs.disko.nixosModules.disko
    ../../hosts/srv-hatchi/bootstrap.nix
  ];
  boot.loader.grub.enable = true;
  disko.devices.disk.vm = {
    type = "disk";
    device = "/dev/vda";
    content = {
      type = "gpt";
      partitions = {
        boot = {
          size = "1M";
          type = "EF02";
        };
        root = {
          size = "100%";
          content = {
            type = "filesystem";
            format = "ext4";
            mountpoint = "/";
          };
        };
      };
    };
  };
  disko.tests = {
    extraChecks = ''
      machine.succeed("test $(hostname) = srv-hatchi")
      machine.wait_for_unit("sshd.service")
      machine.succeed("ip netns add bootstrap-client")
      try:
          machine.succeed("ip link add bootstrap-host type veth peer name bootstrap-peer")
          machine.succeed("ip link set bootstrap-peer netns bootstrap-client")
          machine.succeed("ip address add 192.0.2.1/30 dev bootstrap-host; ip link set bootstrap-host up")
          machine.succeed("ip -n bootstrap-client address add 192.0.2.2/30 dev bootstrap-peer; ip -n bootstrap-client link set bootstrap-peer up")
          machine.wait_until_succeeds("ip netns exec bootstrap-client ssh-keyscan -T 3 192.0.2.1 2>/dev/null | grep -q ssh-ed25519")
      finally:
          machine.succeed("ip netns delete bootstrap-client")
      machine.succeed("findmnt -n /")
      machine.fail("test -e /var/lib/nextcloud/config/config.php")
    '';
  };
}
