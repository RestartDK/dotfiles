#!/usr/bin/env bash
set -euo pipefail

requested=""
if [[ "${1:-}" == --namespace ]]; then
  if [[ $# -lt 2 ]]; then
    printf '%s\n' '--namespace requires a development namespace' >&2
    exit 1
  fi
  requested="$2"
  shift 2
fi

if [[ "$(uname -s)" != Linux || ! -d /var/run/netns ]]; then
  if [[ -n "$requested" ]]; then
    printf '%s\n' 'Development network namespaces are unavailable' >&2
    exit 1
  fi
  exec @browser@ "$@"
fi

user="$(id -un)"
current="$(stat -Lc '%d:%i' /proc/self/ns/net)"
namespace=""
for path in "/var/run/netns/dev-$user" "/var/run/netns/dev-$user-"*; do
  [[ -e "$path" ]] || continue
  if [[ "$(stat -Lc '%d:%i' "$path")" == "$current" ]]; then
    namespace="${path##*/}"
    break
  fi
done

if [[ -n "$requested" ]]; then
  case "$requested" in
  "dev-$user" | "dev-$user-"*) ;;
  *)
    printf '%s\n' 'The requested namespace belongs to another user' >&2
    exit 1
    ;;
  esac
  if [[ "$requested" == */* || ! -e "/var/run/netns/$requested" ]]; then
    printf '%s\n' 'The requested namespace is unavailable' >&2
    exit 1
  fi
  if [[ "$(stat -Lc '%d:%i' "/var/run/netns/$requested")" != "$current" ]]; then
    if [[ ! -x /run/current-system/sw/bin/run-dev-netns ]]; then
      printf '%s\n' 'Install the Cobb host namespace helper before cross-namespace launches' >&2
      exit 1
    fi
    helper="$(readlink -e /run/current-system/sw/bin/run-dev-netns)"
    exec /run/wrappers/bin/sudo -n -E "$helper" "$requested" "$(readlink -e "$0")" "$@"
  fi
  namespace="$requested"
fi

if [[ -n "$namespace" ]]; then
  inode="${current#*:}"
  runtime="/run/user/$(id -u)/tb-$inode"
  storage="$HOME/.local/share/terminal-browser-netns/$inode"
  umask 077
  mkdir -p "$runtime" "$storage"
  export XDG_RUNTIME_DIR="$runtime"
  export XDG_DATA_HOME="$storage/data"
  export XDG_STATE_HOME="$storage/state"
  export XDG_CACHE_HOME="$storage/cache"
  export TERMINAL_BROWSER_APPDATA="$storage/profile"
  export TERMINAL_BROWSER_NAMESPACE="$namespace"
  launcher="$(readlink -e "$0")"
  export TERMINAL_BROWSER_NAMESPACE_LAUNCHER="$launcher"
else
  unset TERMINAL_BROWSER_NAMESPACE TERMINAL_BROWSER_NAMESPACE_LAUNCHER
fi

exec @browser@ "$@"
