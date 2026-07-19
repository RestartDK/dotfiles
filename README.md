# RestartDK dotfiles

Nix-native dotfiles and host configuration for Daniel's machines.

The canonical editable checkout is:

```text
~/.config/dotfiles
```

Remote:

```text
https://github.com/RestartDK/dotfiles
```

## Hosts

```text
hosts/srv-nana/                      # NixOS workstation
hosts/twin/                          # reusable Home Manager dev profile
hosts/dkumlin-macbook-pro/           # personal nix-darwin MacBook config
hosts/dkumlin-twin-macbook-pro/      # work nix-darwin MacBook config
```

## Apply configs

Use the `traitor` wrapper from the repo:

```bash
cd ~/.config/dotfiles
./bin/traitor re
```

Convenience commands:

```bash
traitor re          # rebuild current host
traitor check       # run flake checks
traitor update      # update flake inputs
traitor upgrade     # update, then rebuild
traitor rollback    # roll back current host generation
traitor twin        # apply the Home Manager-only twin profile
traitor nana        # rebuild srv-nana explicitly
traitor mac         # rebuild dkumlin-macbook-pro explicitly
traitor work-mac    # rebuild dkumlin-twin-macbook-pro explicitly
```

Raw commands still work when needed:

```bash
sudo nixos-rebuild switch --flake ~/.config/dotfiles#srv-nana
darwin-rebuild switch --flake ~/.config/dotfiles#dkumlin-macbook-pro
darwin-rebuild switch --flake ~/.config/dotfiles#dkumlin-twin-macbook-pro
nix run github:nix-community/home-manager/release-26.05 -- switch --flake ~/.config/dotfiles#twin -b hm-backup
```

This repo is flake-only; there is intentionally no legacy `configuration.nix` entrypoint.

## Layout

```text
flake.nix                            # flake outputs and inputs
bin/traitor                          # local operations wrapper
hosts/                               # machine-specific host composition
profiles/home/                       # reusable Home Manager bridge profiles
modules/nixos/                       # NixOS reusable modules
modules/home/                        # shared Home Manager modules
  shell/ editors/ terminal/ agents/ desktop/
config/                              # source app dotfiles formerly in dotfiles/
  agents/skills-global/              # portable skills safe to enable broadly
  agents/skills-personal/            # personal-only skills such as homelab/Dokploy
  agents/skills-all/                 # symlink farm combining global + personal skills
packages/                            # local package definitions
```

## Dotfile model

The repo itself is the dotfiles checkout. App config source lives under `config/`:

```text
~/.config/dotfiles/config/ghostty
~/.config/dotfiles/config/nvim
~/.config/dotfiles/config/pi
```

Home Manager links selected files into their runtime locations, for example:

```text
~/.config/ghostty
~/.config/nvim
~/.pi/agent/settings.json
```

High-churn dev and agent config is still managed with explicit out-of-store symlinks:

```nix
config.lib.file.mkOutOfStoreSymlink "/absolute/path/to/repo/file"
```

That keeps those files editable in the Git checkout and avoids copying them into `/nix/store`. Editing a file under `config/` can take effect immediately for live-symlinked apps; rebuilding is needed when changing Nix modules, package lists, services, users, or the set of symlinked paths.

## Cobb bridge profile

This flake exports a reusable Home Manager module for Cobb:

```nix
inputs.daniel-dotfiles.homeManagerModules.cobb-daniel
```

The module lives at:

```text
profiles/home/cobb-daniel.nix
```

It is intended for Cobb's `nix/hosts/profiles/daniel.nix` to import, while Cobb remains responsible for system users, services, networking, and host-level config. Cobb's NixOS Home Manager module remains the sole activator. The bridge contributes Daniel's development packages and network-namespace wrappers, and points high-churn config at:

```text
/home/daniel/.config/dotfiles
```

The package and live-config layers only enable on Cobb dev hosts (`monster`, `titan`, `titan-2`).

## Rules

- Commit Nix modules and portable dotfiles.
- Do not commit secrets, auth files, tokens, SSH private keys, browser profiles, app databases, sessions, logs, caches, sockets, or generated state.
- Use Home Manager for packages and explicit out-of-store symlink declarations.
- Use NixOS / nix-darwin modules for host/system services.
- Add new Nix files with `git add` before rebuilding; flakes only see tracked files.
