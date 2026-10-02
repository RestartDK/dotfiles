# Home Manager bridge for a work repository

This flake exports a reusable Home Manager module for a work repository:

```nix
inputs.daniel-dotfiles.homeManagerModules.cobb-daniel
```

It lives at `profiles/home/cobb-daniel.nix`, and the name still carries the repository it was written for. That repository's own Home Manager host imports it and stays responsible for system users, services, networking, and host-level config. Its NixOS Home Manager module remains the sole activator.

The bridge contributes my development packages, the network-namespace wrappers, and the config groups. The config itself comes from the store there like everywhere else, so nothing in the bridge needs a checkout. A machine in that repository that authors config can keep a checkout and enable the sync unit, which takes its path from `my.liveConfig.sync.checkout`.

The package layer and the config groups only enable on that repository's development hosts.
