# Portable Home Manager module

This flake exports one portable Home Manager module:

```nix
inputs.daniel-dotfiles.homeManagerModules.default
```

It lives at `profiles/home/portable.nix`. It contributes my development packages, the network-namespace wrappers, and the live-config groups. It sets no identity, no AI profile, and no host gate, so the consumer's own Home Manager host stays responsible for system users, services, networking, and host-level config.

A consumer imports it only on the hosts that should get the shell, and sets `my.ai.profile` when it wants the work catalogue instead of the personal default. The config comes from the store like everywhere else, so nothing in the module needs a checkout. A machine that authors config can keep a checkout and enable the sync unit, which takes its path from `my.liveConfig.sync.checkout`.

Cobb is the first consumer. Its `nix/hosts/profiles/daniel.nix` imports the module behind a development-host gate and sets the work profile.
