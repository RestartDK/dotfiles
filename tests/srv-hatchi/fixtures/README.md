# Disposable fixtures

`age-key.txt` is deliberately public and decrypts only `synthetic-secrets.sops.yaml`. Every password is synthetic. Never use this identity or ciphertext for production.

`reference-platform.nix` supplies closure-only QEMU facts. It does not select a physical disk. `../install.nix` owns the disposable `/dev/vda` Disko composition. The nginx fixture in `../services.nix` serves separate Ollama, OpenCode, and Glance-agent markers on ports 8000, 8001, and 8002. It never contacts Nana.

The service VM imports the production module. Only network, credentials, media mounts, and certificate issuance change at the fixture boundary. Runtime DNS and route coverage comes from the independent inventory, not the production route projection. Fixed assertions require 17 source services and 16 replacements. Separate client, admin, and outsider VMs prove distinct CIDR policies. Test-driver code is inline in Nix.
