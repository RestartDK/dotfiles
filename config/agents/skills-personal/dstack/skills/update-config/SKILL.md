---
name: update-config
description: Use whenever Daniel asks to edit, add, refactor, validate, rebuild, update, or make a PR for this computer's configuration or any other computer/host configuration in Daniel's dotfiles/Nix setup. Covers RestartDK/dotfiles, NixOS, nix-darwin, Home Manager, Cobb bridge profile usage, live dotfile symlinks, packages, app config, agent config, and the traitor CLI workflow.
---

# Update Config Skill

Use this skill for changes to Daniel's machine configuration: Nix flakes, NixOS hosts, nix-darwin hosts, Home Manager profiles, `config/` dotfiles, agent/Pi/OpenCode config, packages, overlays, Cobb user bridge config, and PRs for those changes.

## Source of truth

Primary repo:

```text
/Users/danielkumlin/.config/dotfiles
```

Remote:

```text
https://github.com/RestartDK/dotfiles
```

Do not recreate legacy checkout symlinks such as `~/Projects/nix-config`; the repo should live directly in `~/.config/dotfiles`.

Cobb host/profile repo, when editing Cobb integration:

```text
/Users/danielkumlin/Projects/cobb
```

## Always use `traitor` for this repo

Daniel's config operations CLI is `traitor`. Prefer it over raw `nix`, `nixos-rebuild`, `darwin-rebuild`, and `home-manager` commands. Invoke `traitor` directly when it is available on `PATH`; use `./bin/traitor` only as a fallback when PATH is not loaded yet.

Preferred:

```bash
cd ~/.config/dotfiles
traitor path
traitor check
traitor re
```

Common commands:

```bash
traitor path       # print resolved dotfiles checkout
traitor check      # run flake checks
traitor re         # rebuild current host with switch
traitor test       # rebuild current host with test
traitor update     # update flake inputs
traitor upgrade    # update all inputs, then rebuild current host
traitor rollback   # roll back current host generation
traitor twin       # apply Home Manager-only twin profile
traitor nana       # rebuild srv-nana explicitly
traitor mac        # rebuild dkumlin-macbook-pro explicitly
traitor work-mac   # rebuild dkumlin-twin-macbook-pro explicitly
```

Only use raw `nix eval`, `nix build`, or Cobb-specific commands for targeted diagnostics/validation that `traitor` does not cover. If you do, explain why.

## Standard workflow

1. `cd ~/.config/dotfiles` and run `git status --short --branch` before editing.
2. Inspect the relevant host/profile/module files before changing them.
3. Preserve unrelated dirty user changes. Do not overwrite or silently include them in a commit.
4. Put app config under `config/`, not a nested `dotfiles/` directory.
5. Add new Nix files and new dotfiles to Git before evaluating; flakes only see tracked files.
6. Validate with `traitor check` when practical. For targeted validation, evaluate/build the affected flake output.
7. If a rebuild is requested, use `traitor re`/`traitor test` or an explicit host command (`traitor nana`, `traitor mac`, `traitor work-mac`).
8. After any edit, offer to open a PR for it; edits to `config/agents/skills-personal/dstack` always get this offer, since they take effect live and are otherwise unversioned. For PRs, create a branch, commit only intended changes, push, and create the PR with validation notes.

## Repo map

```text
flake.nix                         # flake inputs/outputs
bin/traitor                       # config operations CLI
hosts/<host>/                     # NixOS/nix-darwin host composition
hosts/<host>/home.nix             # host-specific Home Manager config
modules/home/                     # reusable Home Manager feature modules
modules/nixos/                    # reusable NixOS modules
profiles/home/                    # reusable Home Manager profiles/bridges
config/                           # live-editable source dotfiles
packages/                         # local package definitions
overlays/                         # overlays
```

## How to add things

### Add/edit app dotfiles

1. Put source files in `config/<app>/`.
2. Link them from an appropriate module under `modules/home/` using out-of-store symlinks:
   - `modules/home/shell/`
   - `modules/home/editors/`
   - `modules/home/terminal/`
   - `modules/home/agents/`
   - `modules/home/desktop/`
3. Enable the corresponding `my.liveConfig.groups.*` flag in the host/profile.

High-churn config (Neovim, Pi, agent plugins, terminal config) should generally stay live-symlinked so edits apply without rebuilding the file into `/nix/store`.

### Add user packages

- Shared developer/user packages: `modules/home/dev-package-list.nix` or `modules/home/dev-packages.nix`.
- Host-specific user packages: the relevant `hosts/<host>/home.nix`.
- Do not add random host-only tools globally unless Daniel asks.

### Add system config

- NixOS host config: `hosts/srv-nana/default.nix` or a module in `modules/nixos/` imported by the host.
- nix-darwin host config: `hosts/dkumlin-macbook-pro/` or `hosts/dkumlin-twin-macbook-pro/`.
- Home Manager user config: host `home.nix`, `profiles/home/*.nix`, or `modules/home/*`.

### Add or edit agent skills

Personal skills live under:

```text
config/agents/skills-personal/<skill-name>/SKILL.md
```

Portable/global skills live under:

```text
config/agents/skills-global/<skill-name>/SKILL.md
```

If a personal skill should also be available when `skills-all` is linked, add a symlink:

```bash
ln -s ../skills-personal/<skill-name> config/agents/skills-all/<skill-name>
```

### Cobb bridge changes

Cobb owns Cobb machines. Do not copy Daniel's dotfiles into Cobb. Cobb should consume the dotfiles flake/profile.

Dotfiles side:

```text
profiles/home/cobb-daniel.nix
```

Cobb side:

```text
/Users/danielkumlin/Projects/cobb/nix/hosts/profiles/daniel.nix
```

Validate Cobb against a local dotfiles checkout before the remote/lock is updated:

```bash
cd /Users/danielkumlin/Projects/cobb/nix/hosts
nix eval --override-input daniel-dotfiles path:/Users/danielkumlin/.config/dotfiles \
  --no-write-lock-file --allow-dirty \
  .#nixosConfigurations.titan.config.home-manager.users.daniel.home.homeDirectory
```

After the dotfiles PR is merged/pushed, update Cobb's lock/input from the Cobb repo when needed.

## Validation checklist

Run the narrowest useful checks first, then `traitor check` before PR when practical:

```bash
cd ~/.config/dotfiles
traitor check
```

For targeted diagnostics:

```bash
nix eval --raw .#homeConfigurations.twin.activationPackage.drvPath --no-write-lock-file --allow-dirty
nix eval --raw .#darwinConfigurations.dkumlin-macbook-pro.config.system.build.toplevel.drvPath --no-write-lock-file --allow-dirty
nix eval --raw .#darwinConfigurations.dkumlin-twin-macbook-pro.config.system.build.toplevel.drvPath --no-write-lock-file --allow-dirty
nix eval --raw .#nixosConfigurations.srv-nana.config.system.build.toplevel.drvPath --no-write-lock-file --allow-dirty
```

Use `traitor test` or `traitor re` only when Daniel has asked to apply the configuration or when the task clearly requires a local rebuild.

## Safety rules

- Never commit secrets, tokens, auth files, SSH private keys, sessions, logs, caches, sockets, or generated state.
- Be explicit about whether a change only edits files, validates Nix, or actually rebuilds/applies a host.
- Ask before destructive changes, rollbacks, removing profiles, deleting state, or changing production Cobb hosts.
- Keep PR summaries clear: changed files, affected hosts, validation commands, and any pending manual steps.
