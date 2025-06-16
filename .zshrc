# Path to homebrew installation 
export PATH="/opt/homebrew/bin:$PATH"

# Added by LM Studio CLI (lms)
export PATH="$PATH:/Users/danielkumlin/.lmstudio/bin"

# Path to psql 16
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"

# pipx installation config
export PATH="$PATH:/Users/danielkumlin/.local/bin"

# flutter development
export PATH="$HOME/development/flutter/bin:$PATH"

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

# pnpm
export PNPM_HOME="/Users/danielkumlin/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end


# All my aliases
alias ls="eza --icons=always"

eval "$(rbenv init -)"
eval "$(starship init zsh)"
eval $(thefuck --alias)


# Completions for poetry
fpath+=~/.zfunc
autoload -Uz compinit && compinit

# Fabric config
if [ -f "/Users/danielkumlin/.config/fabric/fabric-bootstrap.inc" ]; then . "/Users/danielkumlin/.config/fabric/fabric-bootstrap.inc"; fi


## [Completion]
## Completion scripts setup. Remove the following line to uninstall
[[ -f /Users/danielkumlin/.dart-cli-completion/zsh-config.zsh ]] && . /Users/danielkumlin/.dart-cli-completion/zsh-config.zsh || true
## [/Completion]

