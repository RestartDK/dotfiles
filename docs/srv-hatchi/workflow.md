# Hachi migration workflow

## Completion predicate

The migration is complete only when both Hachi closures build on x86 Linux, deploy-rs schema and activation checks pass, all uncommissioned activation modes reject, the pinned `nixos-anywhere --vm-test` succeeds, and the production service VM passes every assertion. Existing host outputs and `traitor check` must remain valid. Delivery requires ordered commits, a ready PR with green checks, clear review threads, and Babysit `READY`. Do not merge.

Physical installation, live host access, data restoration, and real certificate issuance are outside this run. No physical disk, NIC, boot mode, GPU, or SSH target is inferred from a VM fixture.

## Checklist

No todo tool is available. This file retains the playbook phases and execution checklist.

- [x] Read the Principles section of dstack-mode in full.
- [x] Phase A: Frame
- [x] Phase B: Design the workflow
- [ ] Phase C: Run the loop
- [x] Read every staged file and the inherited review findings.
- [x] Review native lifecycle, secrets, installation authority, test coverage, and existing outputs.
- [x] Run policy, static checks, CLI rejection, and `traitor check` in a dedicated Herdr tab.
- [x] Commit coherent units and push the branch.
- [x] Dispatch the branch workflow and confirm its head SHA and Hachi jobs.
- [ ] Fix each hosted failure at its cause and rerun the affected checks.
- [ ] Phase D: Keep the audit trail
- [ ] Phase E: Verify and hand back
- [ ] Opening a PR. Worktree, Ticket, Commits, PRs, Titles, Descriptions, Submission host, Readiness, Babysit.
- [ ] Babysit. Declare `drive`, check for another watcher, inspect conflicts, clear review threads, diagnose CI, and rearm `watch-pr` after each push until `READY`.
- [ ] Audit the evidence against actual command exits and remove transient processes and tabs.

Delegated architecture, Comment Sicko, cross-model review, and audit workers are skipped because the user forbids subagents. GPT-6 Astra with xhigh reasoning owns implementation, self-review, verification, delivery, and Babysit. The settled native-module architecture does not need another design exploration. Linear is disconnected, so the ticket step is skipped and the PR states that Linear was unavailable.

## Scope and execution

The source is RestartDK/homelab at `2c70dbecd6f421ba03038b0cc203592149d05a9c`. Its root stack declares 17 active services. Sixteen have native replacements. Portainer is removed. Jellyseerr becomes Seerr without an alias. Nextcloud AIO becomes native Nextcloud. All durable configuration belongs to dotfiles. The old repository is only historical source evidence.

This is a high-rigor migration because an incorrect disk target destroys data and an incorrect service default exposes private state. The staged implementation contains 43 changed files and about 2,900 added lines. It starts at `c6de1f6ee713be8bc2b73b047e245ca2a7d08e16` on `daniel/nixos-srv-hatchi`.

The controller is ARM Darwin, without a configured Linux builder. GitHub-hosted x86 Linux with KVM is the required executor. Workflow dispatch is tried first because `nix-ci.yml` already exists on main. If dispatch cannot run the branch workflow, a ready PR supplies the pull-request trigger. Neither path may deploy a host.

## Throughput checkpoint

One writer owns the worktree, lockfile, and audit trail. Local checks precede push. The independent install and service jobs run on separate hosted machines. Existing pins and host modules stay unchanged. Runtime tests import production modules and replace only disposable network, credential, storage, and certificate facts.

The data shapes are native NixOS service options, nullable commissioning records, a strict fresh-or-restored receipt, and an independent source inventory. Shell helpers are limited to receipt admission and credential merges that pinned native options do not provide. No separate Python files are allowed.

`decisions.tsv` records decisions. `commands.tsv` records commands and exits. `validation.md` distinguishes local checks, hosted runtime results, and deferred facts. Inherited temporary paths remain historical pointers, not durable verification proof.
