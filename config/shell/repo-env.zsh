typeset -ga repo_env_hooks=(_repo_env_provider _repo_env_direnv)
typeset -gA repo_env_providers
typeset -gi _repo_env_first_load=1

_repo_env_provider() {
  local directory="$PWD" provider pattern
  while [[ "$directory" != / && ! -f "$directory/.envrc" ]]; do
    directory="${directory:h}"
  done
  [[ -f "$directory/.envrc" ]] || return 0
  for pattern in "${(@k)repo_env_providers}"; do
    if [[ "$directory" == ${~pattern} ]]; then
      if [[ -n "$provider" ]]; then
        print -u2 'repo-env: multiple providers match the target directory'
        return 69
      fi
      provider="${repo_env_providers[$pattern]}"
    fi
  done
  if [[ -n "$provider" ]]; then
      case "$provider" in
        lorri)
          if ! command -v lorri >/dev/null 2>&1; then
            print -u2 'repo-env: selected provider lorri is not installed'
            return 69
          fi
          (cd "$directory" && command lorri watch --once) || return $?
          return 0
          ;;
        *) print -u2 "repo-env: unsupported provider $provider"; return 69 ;;
      esac
  fi
  return 0
}

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
  [[ -n "${REPO_ENV_LAUNCH:-}${REPO_ENV_MANAGED:-}" ]] || repo_env_prepare
  return 0
}
