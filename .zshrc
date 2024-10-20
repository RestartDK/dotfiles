# Path to homebrew installation 
export PATH="/opt/homebrew/bin:$PATH"

# Path to pyenv installation
export PATH="$HOME/.pyenv/bin:$PATH"

# Path to psql 16
export PATH="/opt/homebrew/Cellar/postgresql@16/16.4/bin:$PATH"

# pipx installation config
export PATH="$PATH:/Users/danielkumlin/.local/bin"

# c/c++ config for correct compile and openmp to work
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
export LDFLAGS="-L/opt/homebrew/opt/llvm/lib"
export CPPFLAGS="-I/opt/homebrew/opt/llvm/include"
export LDFLAGS="-L/opt/homebrew/opt/libomp/lib"
export CPPFLAGS="-I/opt/homebrew/opt/libomp/include"

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

#Pyenv config
export PYENV_ROOT="$HOME/.pyenv"
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"
export LC_CTYPE="en_US.UTF-8"
export VIRTUAL_ENV_DISABLE_PROMPT=1

# pnpm
export PNPM_HOME="/Users/danielkumlin/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end

# All my aliases
alias ls="eza --icons=always"

export PYENV_ROOT="$HOME/.pyenv"
[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"
eval "$(starship init zsh)"

# Completions for poetry
fpath+=~/.zfunc
autoload -Uz compinit && compinit

# Fabric config
if [ -f "/Users/danielkumlin/.config/fabric/fabric-bootstrap.inc" ]; then . "/Users/danielkumlin/.config/fabric/fabric-bootstrap.inc"; fi
