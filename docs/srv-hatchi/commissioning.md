# Commission Hachi after discovery

Physical installation is unavailable. Neither named Hachi output imports Disko. No generic installer app exists. `srv-hatchi-install-vm` accepts no arguments and invokes the pinned upstream tool with this flake's fixed bootstrap selector and `--vm-test`. `traitor deploy srv-hatchi` rejects before deploy-rs starts, including `--dry-run`. The profile also rejects normal, dry, boot, and test activation when invoked directly.

## Collect the missing evidence

Before proposing a physical output, collect these facts read-only and record the reviewed evidence in dotfiles.

1. Record the exact SSH target and verified host key, the connection user, boot mode, hardware identity source, and hardware identity value.
2. Record the stable whole-disk by-id path, serial, byte capacity, and every protected disk by-id path.
3. Inventory current mounts, partitions, device holders, and every source data location. Resolve the conflicting historical Hachi addresses without assuming either is current.
4. Restore-test backups and record SHA-256 receipts for hardware inventory, data inventory, and backup verification.
5. Record the physical NIC, IP configuration, client and admin CIDRs, media filesystem identity, and any GPU requirements.
6. Provision the machine age identity and recovery recipient. Add real encrypted service credentials to dotfiles. Do not reuse the public test key.

## Required future guards

The following guards are requirements for the later physical implementation. They are not implemented by the first-pass reference outputs.

- Parse an admitted physical record with the exact SSH target, boot mode, host identity, whole-disk by-id path, serial, byte capacity, protected disks, and three evidence hashes. Reject missing or extra facts, partitions, transient device paths, and protected targets.
- Reobserve host identity, disk serial, byte capacity, mount state, and holders on the target immediately before disk mutation. A stale receipt alone is insufficient.
- Require an explicit one-use destructive approval bound to the host, disk, and evidence hashes.
- Guard `diskoScript`, `diskoScriptNoDeps`, `formatScript`, `destroyScript`, and `destroyFormatMount`. Inspect the pinned Disko API and guard its other destructive aliases too, including `format`, `destroy`, `disko`, and `diskoNoDeps` where present.
- Bind the physical installer to one admitted flake selector and one exact SSH target. Reject arbitrary flags, device overrides, and force bypasses.
- Serialize physical deployment and restore under one host mutation lock. Rollback does not undo disk formatting or database migrations.

The reference platform cannot qualify physical hardware. A VM pass cannot admit a physical target.

## Deploy one node

After a separate approved commissioning change, use `traitor deploy <node> [--dry-run]`. The only allowed node names are `srv-nana` and `srv-hatchi`. Missing nodes, multiple nodes, bootstrap selectors, hostname overrides, and rollback overrides fail at argument parsing.

Nana's configured SSH hostname and user come from its existing native options. Verify connectivity, host identity, and privilege escalation before its first manual deployment. Its activation wrapper also rejects a hostname mismatch. CI builds both deploy profiles and never activates Nana.

Direct use of upstream deploy-rs can bypass the CLI's one-node interface. It is unsupported here. Hachi's refusing profile still protects activation, but the wrapper is not a general authorization system for independently installed tools.
