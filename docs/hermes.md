# Provision Hermes on Hatchi

Hermes runs as a dedicated system user on Hatchi. The pinned upstream NixOS module owns the gateway, dashboard, workspace, and persistent state under `/var/lib/hermes`. It does not enable Docker or Podman, grant sudo, install homelab SSH credentials, or expose a network API.

The web dashboard listens on `127.0.0.1:9119`. It contains browser chat, sessions, memory, skills, and scheduled jobs. Its Chat tab embeds the Hermes terminal UI. The package includes the compiled web and terminal assets, so startup does not install npm dependencies.

## Provision the provider credential

1. Create a service-ready environment field in the Homelab vault that Hatchi's read-only 1Password account can access. Include `OPENROUTER_API_KEY=<key>`. Use a dedicated provider key with an appropriate spending limit.
2. Set `hatchiOnepasswordReferences.hermesEnv` in the private input to that field's `op://vault/item/field` reference.
3. Update the pinned private input through the normal dotfiles workflow and review the resulting change.

Do not put the key, an environment file, or a 1Password service-account token in Git or the Nix store. Hatchi's existing opnix provider retrieves the field into the root-owned `0400` file `/run/hatchi-onepassword/hermesEnv`. systemd reads that environment file when either Hermes service starts. This avoids copying credentials during activation, before opnix has fetched them.

Without the runtime file, both Hermes units are skipped. Hatchi's existing secret references and applications are unchanged. Adding this PR alone does not provision the credential or start a usable model session.

The default model is `deepseek/deepseek-v4.1-flash` through OpenRouter. Change the provider and model declaratively in `hosts/srv-hatchi/services/hermes.nix`. The Nix-managed installation rejects runtime configuration changes. Memories, sessions, and agent-created skills remain mutable.

## Deploy and open the dashboard

1. Satisfy the credential prerequisite before an authorized deployment. Follow [the deployment workflow](deployment.md); opening the PR does not deploy it.
2. After deployment, check `hermes-agent.service` and `hermes-backend.service` on Hatchi. Both depend on the existing secret-file service.
3. From your computer, run `ssh -N -L 9119:127.0.0.1:9119 hatchi`.
4. Open `http://127.0.0.1:9119`.

The loopback dashboard uses its local session-token protection. The SSH connection is the remote access boundary. There is no Caddy route or additional firewall opening. Do not expose this listener through a proxy without configuring Hermes authentication and reviewing its trusted-host policy.

A restart of the shared opnix provider refetches the environment file and restarts dependent services, including Hermes. It also interrupts other applications. Use the existing [secret rotation procedure](../tests/srv-hatchi/onepassword.md), rather than restarting it casually.

Hermes can write its workspace and state. Its units hide user homes, protect the system filesystem, drop capabilities, and require explicit approval for terminal commands. These controls do not make prompts or command approvals a security boundary. No host or service access is configured initially; grant scoped access separately.

## Verify without deployment

Run the packaged runtime and configuration checks:

```sh
traitor check --no-build
nix build --no-link --print-build-logs .#checks.x86_64-linux.srv-hatchi-hermes
```

The focused check uses synthetic local state and no model API calls. It checks the generated native-unit security and credential contracts, launches the actual packaged dashboard twice, fetches the web and chat routes, rejects an unauthenticated configuration request, and verifies persisted state. It does not prove production 1Password access, model responses, or live service activation.
