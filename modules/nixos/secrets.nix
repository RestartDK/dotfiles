{
  config,
  lib,
  pkgs,
  ...
}:
let
  tokenCheck = pkgs.writeShellScript "my-secrets-token-check" ''
    if ! test -s ${lib.escapeShellArg config.my.secrets.tokenFile}; then
      echo "my.secrets: provision ${config.my.secrets.tokenFile} before starting opnix-secrets" >&2
      exit 1
    fi
  '';
in
{
  config = lib.mkIf (config.my.secrets.keys != { }) {
    systemd.services.opnix-secrets.serviceConfig.ExecStartPre = [ "${tokenCheck}" ];
  };
}
