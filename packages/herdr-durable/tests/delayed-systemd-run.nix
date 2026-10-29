{
  writeShellScript,
  nodejs_24,
  systemd,
}:

writeShellScript "dstack-test-delayed-systemd-run" ''
  ${nodejs_24}/bin/node -e 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2750)'
  exec ${systemd}/bin/systemd-run "$@"
''
