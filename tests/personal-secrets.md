# Enable personal Pi credentials

This configuration enables opnix on the personal Mac and Nana. Hatchi keeps its existing secret provider. The work Mac, Twin, Titan, and all Cobb profiles receive no new secret configuration.

## Provision each personal machine

1. Create a separate read-only 1Password service account for each machine. Grant access to the `Developer` vault, `abdtxvj44nyypdbkbehdg4qbfq`. Service accounts have vault-wide access, not item-level access. If that scope is too broad, move the OpenRouter item into a dedicated vault and update its reference in `profiles/personal-secrets.nix`.
2. Save each service-account token in 1Password. Do not put a token or the OpenRouter key in Git, a Nix expression, or a shell command argument.
3. Apply the configuration with `traitor mac` on the personal Mac or `traitor nana` on Nana. Missing tokens do not block the system rebuild. OpenRouter remains unavailable until retrieval succeeds.
4. Prime sudo with `sudo -v`. Read the machine's token into opnix through a pipe. Replace the example reference with the service-account token field, not the OpenRouter key:

   ```sh
   set -o pipefail
   op read 'op://Developer/opnix-personal-mac/credential' | sudo opnix token set
   ```

   The token goes to `/etc/opnix-token`. The service restricts access to root and an otherwise empty `onepassword-secrets` group. Never copy a personal token to a work host.
5. Fetch the OpenRouter key by restarting the appropriate service:

   ```sh
   # Personal Mac
   sudo launchctl kickstart -k system/org.nixos.opnix-secrets

   # Nana
   sudo systemctl restart opnix-secrets.service
   ```

6. Check that `~/.opnix-openrouter-api-key` is nonempty, owned by your user, and has mode `0400`. Do not print its contents. On macOS, use `stat -f '%Su %Sp' ~/.opnix-openrouter-api-key`. On Linux, use `stat -c '%U %a' ~/.opnix-openrouter-api-key`.
7. Start Pi and select an OpenRouter model with `/model`. Send a short prompt to verify the authenticated request. Never use `pi auth print-api-key` to inspect a real credential in logs or chat.

## Refresh or revoke access

After rotating the OpenRouter key in 1Password, restart the secret service with the command above. Pi's model credential command reads the file at request time. Polling is not enabled.

The key file persists across reboots. Missing tokens leave existing keys in place. Removing the profile does not erase the token or key files. To revoke a machine, revoke its service account, remove `/etc/opnix-token` and `~/.opnix-openrouter-api-key`, and rotate the OpenRouter key if it might be compromised.

Pi's `auth.json` stays writable and unmanaged. Existing logins remain intact. On these two personal hosts, `models.json` is generated from `config/pi/agent/models.json` plus the file-backed OpenRouter credential. Rebuild after changing that shared model configuration. Work profiles retain the live symlink.

## Run the offline checks

```sh
nix build --no-link --print-build-logs .#checks.aarch64-darwin.personal-secrets
# On Linux:
nix build --no-link --print-build-logs .#checks.x86_64-linux.personal-secrets
```

The check evaluates both personal hosts and the work exclusions. It runs the real Pi CLI against synthetic keys in an isolated home directory, verifies rotation and existing-login preservation, and checks missing-key failure. It does not contact 1Password or OpenRouter. Complete steps 4 through 7 on each host to verify authenticated retrieval.
