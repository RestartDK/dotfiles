# NixOS / Home Manager configuration

Nix-native config for Daniel's machines.

## Nana

Apply Nana from this repo:

```bash
cd ~/Projects/nixos-config
sudo nixos-rebuild switch --flake .#srv-nana
```

`/etc/nixos` is intentionally a symlink to this checkout:

```text
/etc/nixos -> /home/dkumlin/Projects/nixos-config
```

That keeps the editable Git repo in the normal user workspace while preserving the standard NixOS path.

## Layout

```text
flake.nix                 # flake outputs and inputs
hosts/nana/               # Nana host entrypoint + hardware config
modules/nixos/            # system-level reusable modules
home/dkumlin.nix          # Home Manager user config
home/files/               # dotfiles managed by Home Manager
```

## Rules

- Commit Nix modules and portable dotfiles.
- Do not commit secrets, tokens, SSH private keys, browser profiles, app databases, or Tailscale state.
- Use Home Manager for user config and NixOS modules for host/system services.
- Add new files with `git add` before rebuilding; flakes only see tracked files.
- Later, add `nix-darwin` outputs for macOS and share the `home/` modules.

## Updating

```bash
nix flake update
sudo nixos-rebuild switch --flake .#srv-nana
```
