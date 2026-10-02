#!/usr/bin/env bash
set -euo pipefail

export HERDR_PANE_ID="${HERDR_ACTIVE_PANE_ID:?No selected pane}"
export HERDR_TAB_ID="${HERDR_ACTIVE_TAB_ID:?No selected tab}"
export HERDR_WORKSPACE_ID="${HERDR_ACTIVE_WORKSPACE_ID:?No selected workspace}"

if [[ "$(uname -s)" != Linux || ! -d /var/run/netns ]]; then
  exec terminal-browser open --split right
fi

info="$(herdr pane process-info --pane "$HERDR_PANE_ID")"
namespace="$(jq -r '[.result.process_info.foreground_processes[].argv | . as $argv | range(0; length - 1) as $i | select($argv[$i] | endswith("/run-dev-netns")) | $argv[$i + 1]] | first // empty' <<<"$info")"
if [[ -z "$namespace" ]]; then
  shell_pid="$(jq -er '.result.process_info.shell_pid' <<<"$info")"
  network="$(stat -Lc '%d:%i' "/proc/$shell_pid/ns/net")"
  user="$(id -un)"
  for path in "/var/run/netns/dev-$user" "/var/run/netns/dev-$user-"*; do
    [[ -e "$path" ]] || continue
    if [[ "$(stat -Lc '%d:%i' "$path")" == "$network" ]]; then
      namespace="${path##*/}"
      break
    fi
  done
fi

if [[ -n "$namespace" ]]; then
  exec terminal-browser --namespace "$namespace" open --split right
fi
exec terminal-browser open --split right
