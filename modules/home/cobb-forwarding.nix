{ ... }:

{
  home.file.".local/bin/cobb-forward-titan" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      set -euo pipefail

      DEVUSER="''${DEVUSER:-daniel}"
      MACHINE="''${MACHINE:-titan-2}"

      PORTS=(
        3000
        3001
        3002
        3003
        3004
        3005
        3006
        3007
        3010
        3011
        3012
        3013
        3014
        3015
        3016
        3017
        3018
        3019
        3020
        3050
        3051
      )

      FORWARDS=()
      for PORT in "''${PORTS[@]}"; do
        FORWARDS+=("-L" "$PORT:$DEVUSER:$PORT")
      done

      exec ssh "''${FORWARDS[@]}" "$DEVUSER@$MACHINE"
    '';
  };
}
