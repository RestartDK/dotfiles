# NixOS / nix-darwin / Home Manager configuration

Nix-native config for Daniel's machines.

## Hosts

```text
hosts/srv-nana/                      # NixOS workstation
hosts/twin/                          # reusable Home Manager dev profile
hosts/dkumlin-macbook-pro/           # personal nix-darwin MacBook config
hosts/dkumlin-twin-macbook-pro/      # work nix-darwin MacBook config
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

## Apply reusable twin dev profile

`twin` is a Home Manager-only profile for existing NixOS/Linux target machines
that should get Daniel's shared dev packages and live dotfiles without changing
host-level settings like DNS, SSH, users, groups, Docker, bootloader, or
Tailscale. It installs Pi as the only managed AI agent and links Pi-specific
config while intentionally leaving any existing Codex, Claude, OpenCode, and
shared agent skills installations/config untouched. It uses the `daniel` user by
default and follows `nixpkgs-unstable` for packages.

If the login user or home directory differs, edit `hosts/twin/settings.nix`.
Then apply from the target machine:

```bash
cd ~/Projects/nix-config
nix run github:nix-community/home-manager/release-26.05 -- switch --flake .#twin -b hm-backup
```

## Apply Macs

Personal MacBook:

```bash
cd ~/Projects/nix-config
darwin-rebuild switch --flake .#dkumlin-macbook-pro
```

Work MacBook:

```bash
cd ~/Projects/nix-config
darwin-rebuild switch --flake .#dkumlin-twin-macbook-pro
```

## Layout

```text
flake.nix                            # flake outputs and inputs
hosts/srv-nana/                      # Nana NixOS host + Nana Home Manager entrypoint
hosts/twin/                          # reusable Home Manager dev profile
hosts/dkumlin-macbook-pro/           # personal MacBook nix-darwin host + Home Manager entrypoint
hosts/dkumlin-twin-macbook-pro/      # work MacBook nix-darwin host + Home Manager entrypoint
modules/nixos/                       # NixOS reusable modules, including configurable host identity
modules/home/                        # shared Home Manager modules
dotfiles/                            # live dotfiles linked out-of-store
packages/herdr.nix                   # Herdr binary package for Nana
```

## Live dotfiles

High-churn dev and agent config is managed with Home Manager explicit out-of-store symlinks:

```nix
config.lib.file.mkOutOfStoreSymlink "/absolute/path/to/repo/file"
```

This keeps the files editable in the Git checkout and avoids copying them into `/nix/store`. Editing a file under `dotfiles/` takes effect immediately; rebuilding is only needed when changing Nix modules, package lists, services, users, or the set of symlinked paths.

Managed live config can include shell, Git ignore, Neovim, btop, TheFuck, Herdr, Pi, Codex hooks/rules/skills, Claude, OpenCode, shared agent skills, and selected macOS app config such as AeroSpace, Ghostty, Karabiner, Graphite, SketchyBar, WezTerm, Amp, and cmux. The reusable `twin` profile enables Pi-specific config but not Codex, Claude, OpenCode, or shared agent skills. Codex `config.toml` and RustDesk server/password settings are intentionally local app state, not repo-managed. Tmux config is intentionally not included.

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
