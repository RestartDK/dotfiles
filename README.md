# NixOS / nix-darwin / Home Manager configuration

Nix-native config for Daniel's machines.

## Hosts

```text
hosts/srv-nana/  # NixOS workstation
hosts/mac-pro/   # future nix-darwin MacBook config, not applied yet
```

## Apply Nana

```bash
cd ~/Projects/nix-config
sudo nixos-rebuild switch --flake .#srv-nana
```

`/etc/nixos` on Nana is intentionally a symlink to the editable checkout:

```text
/etc/nixos -> /home/dkumlin/Projects/nix-config
```

## Apply Mac Pro later

Do not run this until the Nana migration has been verified:

```bash
cd ~/Projects/nix-config
darwin-rebuild switch --flake .#mac-pro
```

## Layout

```text
flake.nix                  # flake outputs and inputs
hosts/srv-nana/            # Nana NixOS host + Nana Home Manager entrypoint
hosts/mac-pro/             # Mac Pro nix-darwin host + Mac Home Manager entrypoint
modules/nixos/             # NixOS reusable modules
modules/home/              # shared Home Manager modules
dotfiles/                  # live dotfiles linked out-of-store
packages/herdr.nix         # Herdr binary package for Nana
```

## Live dotfiles

High-churn dev and agent config is managed with Home Manager explicit out-of-store symlinks:

```nix
config.lib.file.mkOutOfStoreSymlink "/absolute/path/to/repo/file"
```

This keeps the files editable in the Git checkout and avoids copying them into `/nix/store`. Editing a file under `dotfiles/` takes effect immediately; rebuilding is only needed when changing Nix modules, package lists, services, users, or the set of symlinked paths.

Managed live config includes shell, Git ignore, Neovim, btop, TheFuck, Herdr, Pi, Codex hooks/rules/skills, Claude, OpenCode, shared agent skills, and selected macOS app config such as AeroSpace, Ghostty, Karabiner, Graphite, SketchyBar, WezTerm, Amp, and cmux. Codex `config.toml` and RustDesk server/password settings are intentionally local app state, not repo-managed. Tmux config is intentionally not included.

## Rules

- Commit Nix modules and portable dotfiles.
- Do not commit secrets, auth files, tokens, SSH private keys, browser profiles, app databases, sessions, logs, caches, sockets, or generated state.
- Use Home Manager for packages and explicit out-of-store symlink declarations.
- Use NixOS / nix-darwin modules for host/system services.
- Add new Nix files with `git add` before rebuilding; flakes only see tracked files.

## Updating

```bash
nix flake update
sudo nixos-rebuild switch --flake .#srv-nana
```
