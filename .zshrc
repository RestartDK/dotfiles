# Defer Cursor Agent shell integration until `agent` is actually used.
agent() {
  unset -f agent

  if [[ -o interactive && -t 0 ]]; then
    eval "$("$HOME/.local/bin/agent" shell-integration zsh)"
  fi

  agent "$@"
}
# Path to homebrew installation 
export PATH="/opt/homebrew/bin:$PATH"

# Path for superset
export PATH="$HOME/.superset/bin:$PATH"

# Added by LM Studio CLI (lms)
export PATH="$PATH:$HOME/.lmstudio/bin"

# Path to psql 16
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
export LDFLAGS="-L/opt/homebrew/opt/postgresql@16/lib"
export CPPFLAGS="-I/opt/homebrew/opt/postgresql@16/include"
export PKG_CONFIG_PATH="/opt/homebrew/opt/postgresql@16/lib/pkgconfig"

# pipx installation config
export PATH="$PATH:$HOME/.local/bin"

# flutter 
export PATH="$PATH:/opt/homebrew/Caskroom/flutter/3.32.4/flutter/bin"

# Add Dart pub global executables to PATH
export PATH="$PATH:$HOME/.pub-cache/bin"

# For rbenv installation
export PATH="$HOME/.rbenv/bin:$PATH"

# Golang env variables
export GOROOT=$(brew --prefix go)/libexec
export GOPATH=$HOME/go
export PATH=$GOPATH/bin:$GOROOT/bin:$HOME/.local/bin:$PATH

# c/c++ config for correct compile and openmp to work
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
export LDFLAGS="-L/opt/homebrew/opt/llvm/lib"
export CPPFLAGS="-I/opt/homebrew/opt/llvm/include"

# bun config for global execs
export PATH="$HOME/.bun/bin:$PATH"

# railpack CLI
export PATH="$HOME/railpack/bin:$PATH"

# fnm config
export FNM_VERSION_FILE_STRATEGY="local"
export FNM_DIR="$HOME/.local/share/fnm"
export FNM_LOGLEVEL="info"
export FNM_NODE_DIST_MIRROR="https://nodejs.org/dist"
export FNM_COREPACK_ENABLED="false"
export FNM_RESOLVE_ENGINES="true"
export FNM_ARCH="arm64"

# editor config
export EDITOR="cursor -w"
export VISUAL="cursor -w"

# Android studio
export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk 
export PATH=$PATH:$ANDROID_HOME/emulator 
export PATH=$PATH:$ANDROID_HOME/platform-tools

# history setup
HISTFILE=$HOME/.zhistory
SAVEHIST=1000
HISTSIZE=999
setopt share_history 
setopt hist_expire_dups_first
setopt hist_ignore_dups
setopt hist_verify

source $(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh
source $(brew --prefix)/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
source $(brew --prefix)/opt/zsh-vi-mode/share/zsh-vi-mode/zsh-vi-mode.plugin.zsh

# fzf config
source <(fzf --zsh)

# All my aliases
alias ls="eza --icons=always"
alias claude-iw="CLAUDE_CONFIG_DIR=~/.claude-iw claude"
alias codex-iw="CODEX_HOME=~/.codex-iw codex"
alias codex-naiss="CODEX_HOME=~/.codex-naiss codex"
opencode-iw() {
  XDG_DATA_HOME="$HOME/.local/share/opencode-iw" \
  OPENCODE_CONFIG="$HOME/.opencode-iw/opencode.json" \
  OPENCODE_CONFIG_DIR="$HOME/.opencode-iw" \
  opencode "$@"
}
opencode-naiss() {
  XDG_DATA_HOME="$HOME/.local/share/opencode-naiss" \
  OPENCODE_CONFIG="$HOME/.opencode-naiss/opencode.json" \
  OPENCODE_CONFIG_DIR="$HOME/.opencode-naiss" \
  opencode "$@"
}
pi-iw() {
  PI_CODING_AGENT_DIR="$HOME/.pi-iw/agent" \
  pi "$@"
}
amp-iw() {
  XDG_DATA_HOME="$HOME/.local/share/amp-iw" \
  AMP_SETTINGS_FILE="$HOME/.config/amp-iw/settings.json" \
  OPENCODE_CONFIG_DIR="$HOME/.opencode-iw" \
  amp "$@"
}
cursor-iw() { cursor --user-data-dir="$HOME/.cursor-iw" "$@"; }
cursor-naiss() { cursor --user-data-dir="$HOME/.cursor-naiss" "$@"; }
cursor-agent-iw() {
  CURSOR_CONFIG_DIR="$HOME/.cursor-iw" \
  CURSOR_DATA_DIR="$HOME/.cursor-iw" \
  CURSOR_API_KEY="$CURSOR_IW_API_KEY" \
  agent "$@"
}

# All my evals
eval "$(fnm env --use-on-cd --shell zsh)"
export PATH="$HOME/.local/bin:$PATH"
eval "$(rbenv init -)"
eval "$(starship init zsh)"
eval $(thefuck --alias)


# Completions for poetry
fpath+=~/.zfunc
autoload -Uz compinit && compinit

## [Completion]
## Completion scripts setup. Remove the following line to uninstall
[[ -f $HOME/.dart-cli-completion/zsh-config.zsh ]] && . $HOME/.dart-cli-completion/zsh-config.zsh || true
## [/Completion]

# pnpm
export PNPM_HOME="$HOME/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end

# bun completions
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"

# kluster.ai CLI
export PATH="$HOME/.kluster/cli/bin:$PATH"
source <(kluster completion zsh)
