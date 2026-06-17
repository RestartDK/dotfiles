{ ... }:

{
  home.file.".local/bin/cobb-forward-titan" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      set -euo pipefail

      DEVUSER="''${DEVUSER:-daniel}"
      MACHINE="''${MACHINE:-titan-2}"
      SSH_USER="''${SSH_USER:-$DEVUSER}"
      TARGET="''${1:-main}"

      usage() {
        cat >&2 <<EOF
      Usage: $(basename "$0") [main|default|base|N|opencode-N|dev-$DEVUSER-opencode-N|$DEVUSER-opencode-N]

      Examples:
        $(basename "$0")              # forwards $DEVUSER namespace
        $(basename "$0") main         # forwards $DEVUSER namespace
        $(basename "$0") 24           # forwards $DEVUSER-opencode-24
        $(basename "$0") opencode-24  # forwards $DEVUSER-opencode-24

      Environment:
        DEVUSER=$DEVUSER
        SSH_USER=$SSH_USER
        MACHINE=$MACHINE
      EOF
      }

      case "$TARGET" in
        main|default|base|"")
          TARGET_HOST="$DEVUSER"
          ;;
        [0-9]*)
          TARGET_HOST="$DEVUSER-opencode-$TARGET"
          ;;
        opencode-[0-9]*)
          TARGET_HOST="$DEVUSER-$TARGET"
          ;;
        dev-''${DEVUSER}-opencode-[0-9]*)
          TARGET_HOST="''${TARGET#dev-}"
          ;;
        ''${DEVUSER}|''${DEVUSER}-opencode-[0-9]*)
          TARGET_HOST="$TARGET"
          ;;
        -h|--help|help)
          usage
          exit 0
          ;;
        *)
          echo "Unknown target: $TARGET" >&2
          usage
          exit 1
          ;;
      esac

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
        8080
        8099
      )

      FORWARDS=()
      for PORT in "''${PORTS[@]}"; do
        FORWARDS+=("-L" "127.0.0.1:''${PORT}:''${TARGET_HOST}:''${PORT}")
      done

      echo "Forwarding local ports to ''${TARGET_HOST} through ''${SSH_USER}@''${MACHINE}" >&2
      echo >&2
      echo "Useful local URLs:" >&2
      echo "  server:           http://localhost:3000" >&2
      echo "  frontend:         http://localhost:3001" >&2
      echo "  goodview:         http://localhost:3002" >&2
      echo "  haproxy:          http://localhost:3005" >&2
      echo "  cosmos:           http://localhost:3050" >&2
      echo "  process-compose:  http://localhost:8099" >&2
      echo >&2
      echo "Stop with Ctrl-C, then rerun with another target to switch stacks." >&2

      exec ssh \
        -N \
        -o ExitOnForwardFailure=yes \
        "''${FORWARDS[@]}" \
        "''${SSH_USER}@''${MACHINE}"
    '';
  };
}
