# Agent rules

## Scope

This repository is Daniel's personal flake for every machine he runs. It is public, `RestartDK` is the only contributor, and it carries no license.

These rules apply to any AI agent that edits this checkout. They sit on top of `~/.agents/skills/dstack/dstack-mode/SKILL.md`, and that mode's non-negotiables still hold. A deeper `AGENTS.md` in a subdirectory adds rules for that subtree.

## Universal rules

Flakes evaluate tracked files only. Run `git add` on a new Nix file or dotfile before any `nix build`, `nix eval`, `nix fmt`, or rebuild.

Run `nix fmt` before every commit. It formats the tree with the programs in `treefmt.nix`, and the CI `quality` check fails on an unformatted file. The dev shell installs a lefthook pre-commit hook that runs the same formatter over staged files.

Never commit secrets or state. The list in `.gitignore` covers secrets, tokens, private keys, sessions, logs, caches, and generated state. Those files stay untracked.

Never push to `main`. Work on a branch named `<handle>/<short-task-name>`, for example `daniel/agent-policy`, in a worktree under `~/.herdr/worktrees/dotfiles/<short-task-name>`.

Titles and commit subjects use `type(scope): subject`. Use a real scope such as `deploy`, `agents`, or `home`. Do not add a Linear issue identifier. This is a personal repository and no tracker covers it.

Never activate or deploy a host unless Daniel asks for it. `traitor re`, `traitor test`, `traitor deploy`, `nixos-rebuild switch`, and `darwin-rebuild switch` all change a machine. State whether a change only edits files, validates Nix, or applies a host.

Ask Daniel before editing these paths:
- `.github/workflows/`
- the `deploy` attrset in `flake.nix`
- `config/ssh/`
- `modules/nixos/deploy.nix`

Keep unrelated dirty changes out of a commit. Run `git status --short --branch` first, then stage only the files the task owns.

Run `traitor check` before opening a pull request that changes a Nix expression, a host, or a module. It runs the flake checks CI depends on, which build the NixOS systems. A documentation-only pull request needs `nix fmt` alone, and CI runs the rest.

## Maintainer workflow

Use `traitor` for this repository instead of raw `nix`, `nixos-rebuild`, `darwin-rebuild`, and `home-manager` commands. Invoke it from `PATH` when it resolves, and fall back to `./bin/traitor` inside the checkout when it does not. The command list and the change workflow live in `config/agents/skills/dstack/skills/update-config/SKILL.md`. Read that skill before touching host, module, profile, or `config/` files.

`traitor --help` prints the available commands. A config change uses `path`, `check`, `re`, `update`, `verify`, and `deploy`.

A change reaches `main` through a pull request. Create the branch in a worktree, edit, run the checks the universal rules name, commit, push, and open the pull request. CI runs the `CI result` job, which requires every stage to pass. Do not merge.

## Automation identity

Unattended automation on this repository is moving to a separate GitHub account, `restartdk-bot`. Daniel has not created the account yet. Interactive agent sessions use Daniel's own account and never the automation token.

Today the `Update flake lock` workflow commits through `FLAKE_UPDATE_TOKEN`, which holds Daniel's personal token. `docs/automation.md` owns the identity, the token scopes, and the migration that removes Daniel's token from the workflow.

The automation identity never merges, never approves a pull request, and never changes `.github/workflows/`. The token carries no `Workflows` permission, so a push that touches a workflow file is rejected.
