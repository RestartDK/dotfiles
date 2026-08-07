{ config, dotfilesInputs, lib, pkgs, ... }:

let
  cfg = config.my.piNetnsWrapper;
  piCodingAgent = dotfilesInputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.pi;
  realPi = "${piCodingAgent}/bin/pi";
  piWrapper = pkgs.writeShellScriptBin "pi" ''
    set -euo pipefail

    current_user="$(${pkgs.coreutils}/bin/id -un)"

    normalize_namespace() {
      candidate="$1"
      case "$candidate" in
        dev-*) printf '%s\n' "$candidate" ;;
        opencode-*) printf '%s\n' "dev-$current_user-$candidate" ;;
        pi-*) printf '%s\n' "dev-$current_user-opencode-''${candidate#pi-}" ;;
        [0-9]*) printf '%s\n' "dev-$current_user-opencode-$candidate" ;;
        *) printf '%s\n' "dev-$candidate" ;;
      esac
    }

    namespace_allowed() {
      case "$1" in
        "dev-$current_user-opencode-"*) return 0 ;;
        *) return 1 ;;
      esac
    }

    have_namespaces() {
      for ns_path in /var/run/netns/dev-$current_user-opencode-*; do
        [ -e "$ns_path" ] && return 0
      done
      return 1
    }

    resolve_run_dev_netns() {
      opencode_path="$(command -v opencode 2>/dev/null || true)"
      if [ -n "$opencode_path" ] && [ -r "$opencode_path" ]; then
        candidate="$(${pkgs.gnugrep}/bin/grep -Eo '/nix/store/[^[:space:]]+-run-dev-netns/bin/run-dev-netns' "$opencode_path" | ${pkgs.coreutils}/bin/head -n 1 || true)"
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
          printf '%s\n' "$candidate"
          return 0
        fi
      fi
      if [ -x /run/current-system/sw/bin/run-dev-netns ]; then
        ${pkgs.coreutils}/bin/readlink -f /run/current-system/sw/bin/run-dev-netns
        return 0
      fi
      printf '%s\n' run-dev-netns
    }

    run_dev_netns="$(resolve_run_dev_netns)"

    process_start_time() {
      target_pid="$1"
      ${pkgs.gawk}/bin/awk '{ print $22 }' "/proc/$target_pid/stat" 2>/dev/null || true
    }

    reserve_current_root_for_namespace() {
      reserved_ns="$1"
      if repo_root="$(${pkgs.git}/bin/git rev-parse --show-toplevel 2>/dev/null)"; then
        :
      else
        repo_root="$(${pkgs.coreutils}/bin/pwd -P)"
      fi
      state_home="''${XDG_STATE_HOME:-$HOME/.local/state}"
      state_dir="$state_home/opencode-netns"
      ${pkgs.coreutils}/bin/mkdir -p "$state_dir/by-root" "$state_dir/by-ns"
      repo_key="$(printf '%s' "$repo_root" | ${pkgs.coreutils}/bin/sha256sum | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"
      exec 8>"$state_dir/lock"
      ${pkgs.util-linux}/bin/flock 8
      printf '%s\n' "$reserved_ns" > "$state_dir/by-root/$repo_key"
      printf '%s\n%s\n%s\n' "$repo_key" "$$" "$(process_start_time "$$")" > "$state_dir/by-ns/$reserved_ns"
      exec 8>&-
    }

    run_namespace() {
      target_namespace="$1"
      shift

      export PI_NETNS_SELECTED="$target_namespace"
      export PI_NETNS_RUN_DEV_NETNS="$run_dev_netns"

      /run/wrappers/bin/sudo -n -E "$run_dev_netns" "$target_namespace" \
        ${realPi} "$@"
    }

    enter_namespace() {
      target_namespace="$1"
      shift
      run_namespace "$target_namespace" "$@"
      exit $?
    }

    if [ -n "''${PI_NETNS:-}" ]; then
      ns="$(normalize_namespace "$PI_NETNS")"
      if ! namespace_allowed "$ns"; then
        echo "Namespace $ns does not belong to $current_user" >&2
        exit 1
      fi
      if [ ! -e "/var/run/netns/$ns" ]; then
        echo "Namespace $ns is not available" >&2
        exit 1
      fi
      reserve_current_root_for_namespace "$ns"
      enter_namespace "$ns" "$@"
    fi

    if ! have_namespaces; then
      exec ${realPi} "$@"
    fi

    if repo_root="$(${pkgs.git}/bin/git rev-parse --show-toplevel 2>/dev/null)"; then
      :
    else
      repo_root="$(${pkgs.coreutils}/bin/pwd -P)"
    fi

    state_home="''${XDG_STATE_HOME:-$HOME/.local/state}"
    state_dir="$state_home/opencode-netns"
    ${pkgs.coreutils}/bin/mkdir -p "$state_dir/by-root" "$state_dir/by-ns"
    repo_key="$(printf '%s' "$repo_root" | ${pkgs.coreutils}/bin/sha256sum | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"
    root_map="$state_dir/by-root/$repo_key"

    exec 9>"$state_dir/lock"
    ${pkgs.util-linux}/bin/flock 9

    namespace_has_pids() {
      target_ns="$1"
      pids="$(${pkgs.iproute2}/bin/ip netns pids "$target_ns" 2>/dev/null || true)"
      [ -n "$pids" ]
    }

    process_matches_start_time() {
      target_pid="$1"
      expected_start_time="$2"
      [ -n "$target_pid" ] || return 1
      [ -n "$expected_start_time" ] || return 1
      [ -e "/proc/$target_pid" ] || return 1
      [ "$(process_start_time "$target_pid")" = "$expected_start_time" ]
    }

    reservation_active_for_other_root() {
      reservation_ns="$1"
      ns_map="$state_dir/by-ns/$reservation_ns"
      [ -r "$ns_map" ] || return 1
      {
        IFS= read -r mapped_key || mapped_key=""
        IFS= read -r mapped_pid || mapped_pid=""
        IFS= read -r mapped_start_time || mapped_start_time=""
      } < "$ns_map"
      [ "$mapped_key" = "$repo_key" ] && return 1
      namespace_has_pids "$reservation_ns" && return 0
      process_matches_start_time "$mapped_pid" "$mapped_start_time"
    }

    cleanup_namespace_state() {
      for ns_map in "$state_dir"/by-ns/*; do
        [ -f "$ns_map" ] || continue
        reservation_ns="''${ns_map##*/}"
        if ! namespace_allowed "$reservation_ns" || [ ! -e "/var/run/netns/$reservation_ns" ]; then
          ${pkgs.coreutils}/bin/rm -f "$ns_map"
          continue
        fi
        {
          IFS= read -r mapped_key || mapped_key=""
          IFS= read -r mapped_pid || mapped_pid=""
          IFS= read -r mapped_start_time || mapped_start_time=""
        } < "$ns_map"
        namespace_has_pids "$reservation_ns" && continue
        process_matches_start_time "$mapped_pid" "$mapped_start_time" && continue
        ${pkgs.coreutils}/bin/rm -f "$ns_map"
      done

      for existing_root_map in "$state_dir"/by-root/*; do
        [ -f "$existing_root_map" ] || continue
        IFS= read -r mapped_ns < "$existing_root_map" || mapped_ns=""
        if [ -z "$mapped_ns" ] || ! namespace_allowed "$mapped_ns" || [ ! -e "/var/run/netns/$mapped_ns" ]; then
          ${pkgs.coreutils}/bin/rm -f "$existing_root_map"
        fi
      done
    }

    cleanup_namespace_state

    choose_namespace() {
      for ns_path in /var/run/netns/dev-$current_user-opencode-*; do
        [ -e "$ns_path" ] || continue
        candidate_ns="''${ns_path##*/}"
        namespace_allowed "$candidate_ns" || continue
        reservation_active_for_other_root "$candidate_ns" && continue
        namespace_has_pids "$candidate_ns" && continue
        printf '%s\n' "$candidate_ns"
        return 0
      done
      return 1
    }

    reserve_namespace() {
      reserved_ns="$1"
      printf '%s\n' "$reserved_ns" > "$root_map"
      printf '%s\n%s\n%s\n' "$repo_key" "$wrapper_pid" "$(process_start_time "$wrapper_pid")" > "$state_dir/by-ns/$reserved_ns"
    }

    ns=""
    if [ -r "$root_map" ]; then
      IFS= read -r mapped_ns < "$root_map" || mapped_ns=""
      if [ -n "$mapped_ns" ] && [ -e "/var/run/netns/$mapped_ns" ] && namespace_allowed "$mapped_ns" && ! reservation_active_for_other_root "$mapped_ns"; then
        ns="$mapped_ns"
      fi
    fi

    if [ -z "$ns" ]; then
      if ! ns="$(choose_namespace)"; then
        echo "No free opencode namespace available for $current_user" >&2
        exit 1
      fi
    fi

    wrapper_pid="$$"
    reserve_namespace "$ns"
    exec 9>&-
    status=0
    if run_namespace "$ns" "$@"; then
      status=0
    else
      status=$?
    fi

    exec 9>"$state_dir/lock"
    ${pkgs.util-linux}/bin/flock 9
    ns_map="$state_dir/by-ns/$ns"
    if [ -r "$ns_map" ]; then
      {
        IFS= read -r mapped_key || mapped_key=""
        IFS= read -r mapped_pid || mapped_pid=""
        IFS= read -r mapped_start_time || mapped_start_time=""
      } < "$ns_map"
      if [ "$mapped_key" = "$repo_key" ] && [ "$mapped_pid" = "$wrapper_pid" ] && process_matches_start_time "$mapped_pid" "$mapped_start_time" && ! namespace_has_pids "$ns" ]; then
        ${pkgs.coreutils}/bin/rm -f "$ns_map"
      fi
    fi
    exec 9>&-
    exit "$status"
  '';
  netnsHook = ''
    [[ ''${HERDR_ENV:-} == "1" ]] || return 0
    [[ ''${HERDR_NETNS_DISABLE_AUTO_ENTER:-} != "1" ]] || return 0
    [[ -d /var/run/netns ]] || return 0

    __herdr_netns_current_user="$(${pkgs.coreutils}/bin/id -un 2>/dev/null)" || return 0

    __herdr_netns_allowed() {
      case "$1" in
        "dev-$__herdr_netns_current_user-opencode-"*) return 0 ;;
        *) return 1 ;;
      esac
    }

    __herdr_netns_have_pool() {
      for __herdr_netns_path in /var/run/netns/dev-$__herdr_netns_current_user-opencode-*(N); do
        [[ -e "$__herdr_netns_path" ]] && return 0
      done
      return 1
    }

    __herdr_netns_have_pool || return 0

    if [[ -n ''${PI_NETNS_SELECTED:-} ]]; then
      __herdr_netns_target="$PI_NETNS_SELECTED"
    else
      __herdr_netns_repo_root="$(${pkgs.git}/bin/git rev-parse --show-toplevel 2>/dev/null)" || return 0
      __herdr_netns_state_home="''${XDG_STATE_HOME:-$HOME/.local/state}"
      __herdr_netns_state_dir="$__herdr_netns_state_home/opencode-netns"
      ${pkgs.coreutils}/bin/mkdir -p "$__herdr_netns_state_dir/by-root" "$__herdr_netns_state_dir/by-ns" 2>/dev/null || return 0
      __herdr_netns_repo_key="$(printf '%s' "$__herdr_netns_repo_root" | ${pkgs.coreutils}/bin/sha256sum | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"
      __herdr_netns_root_map="$__herdr_netns_state_dir/by-root/$__herdr_netns_repo_key"

      __herdr_netns_has_pids() {
        __herdr_netns_pids="$(${pkgs.iproute2}/bin/ip netns pids "$1" 2>/dev/null || true)"
        [[ -n "$__herdr_netns_pids" ]]
      }

      __herdr_netns_process_start_time() {
        ${pkgs.gawk}/bin/awk '{ print $22 }' "/proc/$1/stat" 2>/dev/null || true
      }

      __herdr_netns_process_matches_start_time() {
        [[ -n "$1" ]] || return 1
        [[ -n "$2" ]] || return 1
        [[ -e "/proc/$1" ]] || return 1
        [[ "$(__herdr_netns_process_start_time "$1")" == "$2" ]]
      }

      __herdr_netns_reservation_active_for_other_root() {
        __herdr_netns_reservation_ns="$1"
        __herdr_netns_ns_map="$__herdr_netns_state_dir/by-ns/$__herdr_netns_reservation_ns"
        [[ -r "$__herdr_netns_ns_map" ]] || return 1
        {
          IFS= read -r __herdr_netns_mapped_key || __herdr_netns_mapped_key=""
          IFS= read -r __herdr_netns_mapped_pid || __herdr_netns_mapped_pid=""
          IFS= read -r __herdr_netns_mapped_start_time || __herdr_netns_mapped_start_time=""
        } < "$__herdr_netns_ns_map"
        [[ "$__herdr_netns_mapped_key" == "$__herdr_netns_repo_key" ]] && return 1
        __herdr_netns_has_pids "$__herdr_netns_reservation_ns" && return 0
        __herdr_netns_process_matches_start_time "$__herdr_netns_mapped_pid" "$__herdr_netns_mapped_start_time"
      }

      __herdr_netns_cleanup_state() {
        for __herdr_netns_ns_map in "$__herdr_netns_state_dir"/by-ns/*(N); do
          [[ -f "$__herdr_netns_ns_map" ]] || continue
          __herdr_netns_reservation_ns="''${__herdr_netns_ns_map##*/}"
          if ! __herdr_netns_allowed "$__herdr_netns_reservation_ns" || [[ ! -e "/var/run/netns/$__herdr_netns_reservation_ns" ]]; then
            ${pkgs.coreutils}/bin/rm -f "$__herdr_netns_ns_map" 2>/dev/null || true
            continue
          fi
          {
            IFS= read -r __herdr_netns_mapped_key || __herdr_netns_mapped_key=""
            IFS= read -r __herdr_netns_mapped_pid || __herdr_netns_mapped_pid=""
            IFS= read -r __herdr_netns_mapped_start_time || __herdr_netns_mapped_start_time=""
          } < "$__herdr_netns_ns_map"
          __herdr_netns_has_pids "$__herdr_netns_reservation_ns" && continue
          __herdr_netns_process_matches_start_time "$__herdr_netns_mapped_pid" "$__herdr_netns_mapped_start_time" && continue
          ${pkgs.coreutils}/bin/rm -f "$__herdr_netns_ns_map" 2>/dev/null || true
        done

        for __herdr_netns_existing_root_map in "$__herdr_netns_state_dir"/by-root/*(N); do
          [[ -f "$__herdr_netns_existing_root_map" ]] || continue
          IFS= read -r __herdr_netns_mapped_ns < "$__herdr_netns_existing_root_map" || __herdr_netns_mapped_ns=""
          if [[ -z "$__herdr_netns_mapped_ns" ]] || ! __herdr_netns_allowed "$__herdr_netns_mapped_ns" || [[ ! -e "/var/run/netns/$__herdr_netns_mapped_ns" ]]; then
            ${pkgs.coreutils}/bin/rm -f "$__herdr_netns_existing_root_map" 2>/dev/null || true
          fi
        done
      }

      __herdr_netns_choose_namespace() {
        for __herdr_netns_path in /var/run/netns/dev-$__herdr_netns_current_user-opencode-*(N); do
          [[ -e "$__herdr_netns_path" ]] || continue
          __herdr_netns_candidate="''${__herdr_netns_path##*/}"
          __herdr_netns_allowed "$__herdr_netns_candidate" || continue
          __herdr_netns_reservation_active_for_other_root "$__herdr_netns_candidate" && continue
          __herdr_netns_has_pids "$__herdr_netns_candidate" && continue
          printf '%s\n' "$__herdr_netns_candidate"
          return 0
        done
        return 1
      }

      {
        ${pkgs.util-linux}/bin/flock 9 || return 0
        __herdr_netns_cleanup_state
        __herdr_netns_target=""
        if [[ -r "$__herdr_netns_root_map" ]]; then
          IFS= read -r __herdr_netns_mapped_ns < "$__herdr_netns_root_map" || __herdr_netns_mapped_ns=""
          if [[ -n "$__herdr_netns_mapped_ns" ]] && [[ -e "/var/run/netns/$__herdr_netns_mapped_ns" ]] && __herdr_netns_allowed "$__herdr_netns_mapped_ns" && ! __herdr_netns_reservation_active_for_other_root "$__herdr_netns_mapped_ns"; then
            __herdr_netns_target="$__herdr_netns_mapped_ns"
          fi
        fi
        if [[ -z "$__herdr_netns_target" ]]; then
          __herdr_netns_target="$(__herdr_netns_choose_namespace)" || return 0
        fi
        printf '%s\n' "$__herdr_netns_target" > "$__herdr_netns_root_map"
        printf '%s\n%s\n%s\n' "$__herdr_netns_repo_key" "$$" "$(__herdr_netns_process_start_time "$$")" > "$__herdr_netns_state_dir/by-ns/$__herdr_netns_target"
      } 9>"$__herdr_netns_state_dir/lock"
    fi

    __herdr_netns_allowed "$__herdr_netns_target" || return 0
    [[ -e "/var/run/netns/$__herdr_netns_target" ]] || return 0

    __herdr_netns_current="$(${pkgs.iproute2}/bin/ip netns identify $$ 2>/dev/null | ${pkgs.coreutils}/bin/head -n 1 || true)"
    [[ "$__herdr_netns_current" == "$__herdr_netns_target" ]] && return 0

    __herdr_netns_resolve_run_dev_netns() {
      __herdr_netns_opencode_path="$(command -v opencode 2>/dev/null || true)"
      if [[ -n "$__herdr_netns_opencode_path" && -r "$__herdr_netns_opencode_path" ]]; then
        __herdr_netns_candidate="$(${pkgs.gnugrep}/bin/grep -Eo '/nix/store/[^[:space:]]+-run-dev-netns/bin/run-dev-netns' "$__herdr_netns_opencode_path" | ${pkgs.coreutils}/bin/head -n 1 || true)"
        if [[ -n "$__herdr_netns_candidate" && -x "$__herdr_netns_candidate" ]]; then
          printf '%s\n' "$__herdr_netns_candidate"
          return 0
        fi
      fi
      if [[ -x /run/current-system/sw/bin/run-dev-netns ]]; then
        ${pkgs.coreutils}/bin/readlink -f /run/current-system/sw/bin/run-dev-netns
        return 0
      fi
      printf '%s\n' run-dev-netns
    }

    __herdr_netns_run_dev_netns="$(__herdr_netns_resolve_run_dev_netns)"
    /run/wrappers/bin/sudo -n -E "$__herdr_netns_run_dev_netns" "$__herdr_netns_target" true >/dev/null 2>&1 || return 0

    export PI_NETNS="$__herdr_netns_target"
    export PI_NETNS_SELECTED="$__herdr_netns_target"
    export PI_NETNS_RUN_DEV_NETNS="$__herdr_netns_run_dev_netns"
    export HERDR_NETNS_AUTO_ENTERED=1

    exec /run/wrappers/bin/sudo -n -E "$__herdr_netns_run_dev_netns" "$__herdr_netns_target" "''${SHELL:-/bin/zsh}" -l
  '';
in
{
  options.my.piNetnsWrapper.enable =
    lib.mkEnableOption "Pi and Herdr integration with Cobb development network namespaces";

  config = lib.mkIf cfg.enable {
    home.packages = [ piWrapper ];
    home.file.".config/herdr/netns-hook.zsh".text = netnsHook;
  };
}
