typeset -ga repo_env_hooks=(_repo_env_direnv)
typeset -gi _repo_env_first_load=1

_repo_env_direnv() {
  local directory="$PWD"
  while [[ "$directory" != / && ! -f "$directory/.envrc" ]]; do
    directory="${directory:h}"
  done
  if ! command -v direnv >/dev/null 2>&1; then
    if [[ -f "$directory/.envrc" || -n "${DIRENV_DIFF:-}" ]]; then
      print -u2 'repo-env: direnv is required for this environment'
      return 69
    fi
    return 0
  fi

  local exports
  if (( _repo_env_first_load )) && [[ -f "$directory/.envrc" ]]; then
    exports="$(DIRENV_FILE= command direnv export zsh)" || return $?
  else
    exports="$(command direnv export zsh)" || return $?
  fi
  eval "$exports" || return $?
  _repo_env_first_load=0
}

repo_env_prepare() {
  local hook result
  for hook in "${repo_env_hooks[@]}"; do
    if (( ! $+functions[$hook] )); then
      print -u2 "repo-env: preparation hook $hook is not defined"
      return 69
    fi
    "$hook"
    result=$?
    if (( result != 0 )); then
      print -u2 "repo-env: $hook failed with status $result; command not started"
      return "$result"
    fi
  done
}

_repo_env_prompt() {
  repo_env_prepare
  local result=$?
  if [[ -n "${PI_HERDR_READY_FILE:-}" ]]; then
    print -r -- "$result" > "$PI_HERDR_READY_FILE"
    unset PI_HERDR_READY_FILE
  fi
  return 0
}
