{ pkgs, ... }:

{
  # The portable live .zshrc sources this optional fragment before loading the
  # rest of the shell. It is inert away from Cobb hosts and non-VS Code shells.
  xdg.configFile."shell/cobb-vscode-netns.zsh".text = ''
    if [[ -n "''${VSCODE_IPC_HOOK_CLI:-}" ]] && [[ -e /var/run/netns/dev-$USER ]]; then
      current_ns="$(${pkgs.coreutils}/bin/stat -Lc '%d:%i' /proc/self/ns/net)"
      target_ns="$(${pkgs.coreutils}/bin/stat -Lc '%d:%i' /var/run/netns/dev-$USER)"
      if [[ "$current_ns" != "$target_ns" ]]; then
        run_dev_netns=/run/current-system/sw/bin/run-dev-netns
        if [[ ! -x "$run_dev_netns" ]]; then
          run_dev_netns="$(command -v run-dev-netns 2>/dev/null || true)"
        fi
        if [[ -n "$run_dev_netns" ]] && [[ -x /run/wrappers/bin/sudo ]]; then
          exec /run/wrappers/bin/sudo -n -E "$run_dev_netns" dev-$USER \
            ${pkgs.zsh}/bin/zsh -l
        fi
      fi
    fi
  '';
}
