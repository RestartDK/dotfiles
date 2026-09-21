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
traitor sync        # rebase the checkout onto its upstream
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
  agents/skills/                     # every agent skill, dstack included; one tree linked to every harness
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

`traitor sync` fetches the current branch's configured remote and rebases local commits onto its upstream. It temporarily stores tracked and untracked edits, then restores them after the rebase. A preflight worktree checks both the rebase and the edit restoration before the live checkout moves. Conflicts leave the original branch and dirty files unchanged.

Nana and both managed Macs run the same command at login or boot and every 15 minutes. An offline machine keeps its checkout unchanged and retries later without a notification. A Mac shows a notification when a Git conflict blocks synchronization. The systemd and launchd jobs only synchronize Git; they never rebuild a machine, commit files, push branches, or switch branches.

## CI and deployment

Every pull request and `main` push runs one `CI result` job. A single Nix command checks formatting, lint, personal secrets, and Hatchi deployment safeguards, then builds the Nana and Hatchi NixOS systems. This gate does not build Darwin or Twin, run VM tests, deploy, activate, reboot, or contact either host.

`traitor verify srv-hatchi services-vm` remains a manual diagnostic. `traitor verify srv-hatchi policy` runs the same deployment safeguards checked by CI, including bootstrap validation and exact-node CLI behavior.

`traitor deploy <node>` builds locally by default. For deployment from a Mac without a Linux builder, add `--remote-build` to build on the target instead. Both `srv-nana` and `srv-hatchi` accept the flag.

```bash
traitor deploy srv-hatchi --remote-build
traitor deploy srv-hatchi --remote-build --dry-run
```

`--dry-run` builds the configuration and runs deploy-rs dry activation without switching the active system. The pinned deploy-rs can exit successfully after a failed dry-activation check; inspect its diagnostics rather than treating exit zero as a readiness gate. The two flags can appear in either order after the node. Linux CI keeps local builds by omitting `--remote-build`.

`deploy.yml` is separate from CI. It reacts only to successful CI for a push to the current `main` revision. Both remote jobs are hard-disabled by their `if: false && ...` conditions, so they cannot read deployment secrets, join Tailscale, or SSH until those conditions are deliberately changed. Once enabled, a host deploys after every successful `main` build. Nana first invokes `traitor sync --expect REVISION`; a conflict or revision mismatch stops before deploy-rs can change the system.

Before enabling a host, configure its GitHub environment, `srv-nana` or `srv-hatchi`, with required approval and these secrets:

- `TS_OAUTH_CLIENT_ID` and `TS_AUDIENCE` for a Tailscale federated identity restricted to this repository, environment, and `tag:ci-deploy`.
- `SSH_PRIVATE_KEY` for the configured deployment user.
- `SSH_KNOWN_HOSTS` with the independently verified host key for `srv-nana` or `srv-hatchi`. Host-key checking remains strict.

The tailnet policy must permit that tag to reach the selected host on SSH. The host must resolve by its deployment name, authorize the SSH key, and permit unattended sudo. The workflow uses OpenSSH over Tailscale, not Tailscale SSH authentication. The Tailscale action removes its ephemeral runner when the job ends.

Hatchi's physical profile puts EFI, NixOS, service state, and databases on the system SSD. The data HDD mounts at `/srv` for media and Nextcloud files. A missing data disk does not block NixOS or SSH, but it prevents the application stack from starting.

Hatchi has one physical NixOS configuration for installation and deployment. Its stable disk IDs and generated hardware facts are committed. Follow [the Hatchi installation procedure](hosts/srv-hatchi/INSTALL.md) to run the guarded `nixos-anywhere` installation from a clean `main` checkout.

Hatchi's production configuration enables runtime 1Password secrets and declares its LAN as `192.168.200.0/24`. SSH remains allowed on `tailscale0` independently of the LAN rules. Before deployment, [provision the SOPS bootstrap files](hosts/srv-hatchi/INSTALL.md#provision-secrets-before-deployment). A native pre-switch check rejects missing or undecryptable bootstrap files before changing running services. Credential formats and verification limits are documented in [the secret integration guide](tests/srv-hatchi/onepassword.md).

## Personal Pi secrets

Both Macs and Nana use opnix to fetch the OpenRouter key from 1Password. Follow [the provisioning guide](tests/personal-secrets.md) to install each machine's service-account token and verify retrieval. Twin Linux and the Cobb bridge do not import this configuration.

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
