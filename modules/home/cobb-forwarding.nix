_:

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

  home.file.".local/bin/cobb-tunnels" = {
    executable = true;
    text = ''
      #!/usr/bin/env bash
      set -euo pipefail

      DEVUSER="''${DEVUSER:-daniel}"
      MACHINE="''${MACHINE:-titan-2}"
      SSH_USER="''${SSH_USER:-$DEVUSER}"
      SSH_PORT="''${SSH_PORT:-2222}"
      IDENTITY_FILE="''${IDENTITY_FILE:-$HOME/.ssh/id_ed25519.pub}"
      IDENTITY_AGENT="''${SSH_AUTH_SOCK:-$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock}"
      STATE_DIR="''${XDG_STATE_HOME:-$HOME/.local/state}/cobb-tunnels"
      CONTROL_SOCKET="$STATE_DIR/titan-2.sock"

      export SSH_AUTH_SOCK="$IDENTITY_AGENT"

      mkdir -p "$STATE_DIR"
      chmod 700 "$STATE_DIR"

      SSH_COMMON=(
        -F /dev/null
        -S "$CONTROL_SOCKET"
        -p "$SSH_PORT"
        -l "$SSH_USER"
        -o "IdentityFile=$IDENTITY_FILE"
        -o IdentitiesOnly=yes
      )

      master_check() {
        ssh "''${SSH_COMMON[@]}" -O check "$MACHINE"
      }

      start_tunnels() {
        if master_check >/dev/null 2>&1; then
          echo "Cobb tunnels are already running."
          return 0
        fi

        rm -f "$CONTROL_SOCKET"

        forwards=()
        for slot in $(seq 1 50); do
          forwards+=(
            -L "127.0.0.1:$((30000 + slot)):$DEVUSER-opencode-$slot:3000"
            -L "127.0.0.1:$((31000 + slot)):$DEVUSER-opencode-$slot:3001"
            -L "127.0.0.1:$((32000 + slot)):$DEVUSER-opencode-$slot:3002"
            -L "127.0.0.1:$((35000 + slot)):$DEVUSER-opencode-$slot:3050"
            -L "127.0.0.1:$((36000 + slot)):$DEVUSER-opencode-$slot:$((36000 + slot))"
            -L "127.0.0.1:$((37000 + slot)):$DEVUSER-opencode-$slot:3010"
            -L "127.0.0.1:$((38000 + slot)):$DEVUSER-opencode-$slot:8099"
            -L "127.0.0.1:$((39000 + slot)):$DEVUSER-opencode-$slot:9012"
            -L "127.0.0.1:$((40000 + slot)):$DEVUSER-opencode-$slot:9013"
          )
        done

        ssh \
          "''${SSH_COMMON[@]}" \
          -fN \
          -M \
          -o ExitOnForwardFailure=yes \
          -o ServerAliveInterval=30 \
          -o ServerAliveCountMax=3 \
          "''${forwards[@]}" \
          "$MACHINE"

        if ! master_check >/dev/null 2>&1; then
          rm -f "$CONTROL_SOCKET"
          echo "Cobb tunnel process did not remain running." >&2
          return 1
        fi

        echo "Cobb tunnels started in the background."
      }

      stop_tunnels() {
        if ! master_check >/dev/null 2>&1; then
          rm -f "$CONTROL_SOCKET"
          echo "Cobb tunnels are not running."
          return 0
        fi

        ssh "''${SSH_COMMON[@]}" -O exit "$MACHINE" >/dev/null
        rm -f "$CONTROL_SOCKET"
        echo "Cobb tunnels stopped."
      }

      status_tunnels() {
        if status="$(master_check 2>/dev/null)"; then
          echo "$status"
          echo "Cobb tunnels are running."
        else
          rm -f "$CONTROL_SOCKET"
          echo "Cobb tunnels are not running."
          return 1
        fi
      }

      print_urls() {
        slot="''${1:-}"
        case "$slot" in
          ""|*[!0-9]*)
            echo "Usage: cobb-tunnels urls <1-50>" >&2
            return 1
            ;;
        esac
        slot_number=$((10#$slot))
        if [ "$slot_number" -lt 1 ] || [ "$slot_number" -gt 50 ]; then
          echo "Namespace slot must be between 1 and 50." >&2
          return 1
        fi

        echo "Frontend:        http://cobb-$slot_number.localhost:$((31000 + slot_number))"
        echo "API:             http://cobb-$slot_number.localhost:$((30000 + slot_number))"
        echo "Goodview:        http://cobb-$slot_number.localhost:$((32000 + slot_number))"
        echo "React Cosmos:    http://cobb-$slot_number.localhost:$((35000 + slot_number))"
        echo "Cosmos renderer: http://cobb-$slot_number.localhost:$((36000 + slot_number))"
        echo "Grafana:         http://cobb-$slot_number.localhost:$((37000 + slot_number))"
        echo "Process Compose: http://cobb-$slot_number.localhost:$((38000 + slot_number))"
        echo "Artifacts:       http://cobb-$slot_number.localhost:$((39000 + slot_number))"
        echo "RustFS console:  http://cobb-$slot_number.localhost:$((40000 + slot_number))"
      }

      usage() {
        echo "Usage: cobb-tunnels {start|stop|restart|status|urls <1-50>}" >&2
      }

      case "''${1:-}" in
        start)
          start_tunnels
          ;;
        stop)
          stop_tunnels
          ;;
        restart)
          stop_tunnels
          start_tunnels
          ;;
        status)
          status_tunnels
          ;;
        urls)
          print_urls "''${2:-}"
          ;;
        *)
          usage
          exit 1
          ;;
      esac
    '';
  };
}
