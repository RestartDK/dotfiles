{
  lib,
  testers,
  writeText,
  runtimeShell,
  nodejs_24,
  util-linux,
  systemd,
  dstack,
  commandHelper,
}:
let
  script = writeText "host-reboot-proof.mjs" (builtins.readFile ./host-reboot-proof.mjs);
  environment = {
    DSTACK_FAULT_VM = "1";
    DSTACK_TEST_NODE = "${nodejs_24}/bin/node";
    DSTACK_VM_FIXTURE = "${dstack}/libexec/dstack/dist/tests/host-command-fixture.js";
    DSTACK_FLOCK = "${util-linux}/bin/flock";
    DSTACK_COMMAND_HELPER = "${lib.getExe commandHelper}";
    DSTACK_SYSTEMD_RUN = "${systemd}/bin/systemd-run";
    DSTACK_SYSTEMCTL = "${systemd}/bin/systemctl";
    DSTACK_BUSCTL = "${systemd}/bin/busctl";
    XDG_RUNTIME_DIR = "/run/user/1000";
    DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
  };
  envArgs = lib.concatStringsSep " " (
    lib.mapAttrsToList (name: value: lib.escapeShellArg "${name}=${value}") environment
  );
  run =
    stage:
    "runuser -u proof -- ${runtimeShell} -c ${lib.escapeShellArg "cd /home/proof && exec env ${envArgs} ${nodejs_24}/bin/node ${script} ${stage}"}";
in
testers.runNixOSTest {
  name = "durable-command-reboot";
  globalTimeout = 300;
  nodes.machine = {
    networking.hostName = "durable-proof";
    users.users.proof = {
      isNormalUser = true;
      uid = 1000;
      group = "users";
    };
    virtualisation = {
      memorySize = 1536;
      cores = 2;
      diskSize = 2048;
    };
    environment.systemPackages = [ util-linux ];
    system.stateVersion = "26.05";
  };
  testScript = ''
    import json

    machine.start()
    machine.wait_for_unit("multi-user.target")
    machine.succeed("loginctl enable-linger proof")
    machine.wait_for_unit("user@1000.service")
    machine.wait_for_file("/run/user/1000/bus")
    machine.succeed("install -d -o proof -g users -m 700 /home/proof/reboot")
    machine.succeed(${builtins.toJSON "${run "before"} >/home/proof/reboot/before.log 2>&1 &"})
    machine.wait_until_succeeds("grep -q before-power-cut /home/proof/reboot/before.log", timeout=60)
    before = machine.succeed("sysctl -n kernel.random.boot_id").strip()
    machine.crash()
    machine.start()
    machine.wait_for_unit("multi-user.target")
    machine.wait_for_unit("user@1000.service")
    machine.wait_for_file("/run/user/1000/bus")
    after = machine.succeed("sysctl -n kernel.random.boot_id").strip()
    assert before != after
    status, _ = machine.execute(${builtins.toJSON "${run "after"} >/home/proof/reboot/after.log 2>&1"}, timeout=60)
    print(machine.succeed("tail -c 32768 /home/proof/reboot/after.log"))
    machine.succeed("tar -C /home/proof -cf /tmp/reboot-evidence.tar reboot")
    machine.copy_from_machine("/tmp/reboot-evidence.tar", "evidence")
    assert status == 0, f"post-reboot proof failed with status {status}"
    print(json.dumps({"proof": "real-kernel-reboot", "beforeBootId": before, "afterBootId": after}))
  '';
}
