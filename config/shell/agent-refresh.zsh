# Keep one shared SSH agent socket across the processes a dev host inherits.
#
# Herdr's server, its remote client bridge, and every dev-namespace process on
# the Twin and Cobb hosts inherit SSH_AUTH_SOCK from whichever connection
# started them. When that connection ends the inherited path is dead, and the
# replacement socket arrives on a new path that nobody points at. Keep a stable
# indirection at ~/.ssh/agent/current, repoint it whenever a connection brings a
# live forwarded socket, and export that, so later processes stop inheriting a
# path that dies with its connection.
#
# Linux only: macOS loads the 1Password agent above and needs no indirection.
if [[ "$OSTYPE" == linux* ]]; then
  agent_dir="$HOME/.ssh/agent"
  agent_link="$agent_dir/current"
  incoming_agent="${SSH_AUTH_SOCK:-}"

  if [[ -n "$incoming_agent" ]] &&
     [[ "$incoming_agent" != "$agent_link" ]] &&
     [[ -S "$incoming_agent" ]] &&
     { [[ "${ZSH_EXECUTION_STRING:-}" == *"herdr remote-client-bridge"* ]] || [[ ! -S "$agent_link" ]]; }; then
    mkdir -p "$agent_dir"
    ln -sfn "$incoming_agent" "$agent_link"
  fi

  if [[ -S "$agent_link" ]]; then
    export SSH_AUTH_SOCK="$agent_link"
  fi
fi
