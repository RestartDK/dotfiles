# Open Hermes on Hatchi

Hermes runs natively as a dedicated system user on Hatchi. The pinned upstream module owns the gateway, dashboard, workspace, and state under `/var/lib/hermes`. Docker and Podman stay disabled. Hermes receives no sudo access, homelab SSH key, or user-home access.

## Check credentials before deployment

1. Confirm that Hatchi's read-only 1Password service account can retrieve `network.personalSecretReferences.opencodeApiKey`. This is the existing OpenCode Go API-key reference, not a new key or an environment-file field.
2. Confirm that `hatchiOnepasswordReferences.glancePassword` contains the normal Glance login password without surrounding whitespace. Hermes trims its configured password. Both applications use `daniel`, but their login pages, cookies, and signing keys are separate.
3. If the Go key's vault is inaccessible, resolve its delivery before deployment. Do not grant broad personal-vault access just to start Hermes. A scoped Homelab reference to the existing key is an alternative, but changing that private reference requires separate review.

Do not put credential values, environment files, or service-account tokens in Git or the Nix store. opnix retrieves the Go key into `/run/hatchi-onepassword/hermesGoKey`, owned by root with mode `0400`. It already retrieves the Glance password. systemd passes private copies through `LoadCredential`. Small launch scripts read those files, export the upstream environment variables, and execute the upstream commands. They do not create a persistent `.env` file. Only the dashboard receives the login-password credential; both Hermes services receive the Go key.

Without the Go runtime file, both Hermes units are skipped. A missing dashboard-password credential prevents dashboard startup. A failed 1Password fetch can also affect other applications because Hatchi uses a shared provider. Do not deploy until service-account access is verified.

The model is `glm-5.3-flash` through the native `opencode-go` provider. OpenCode Go's subscription limits and coding-agent usage policy still apply. Provider compatibility does not establish permission for arbitrary assistant traffic. Change the provider and model declaratively in `hosts/srv-hatchi/services/hermes.nix`. Memories, sessions, and agent-created skills remain mutable.

## Deploy and sign in

1. Complete the credential checks before an authorized deployment. Follow [the deployment workflow](deployment.md). Opening a PR does not deploy Hatchi.
2. After deployment, check `hermes-agent.service` and `hermes-backend.service` on Hatchi. Both depend on the existing secret-file service.
3. Open Glance and select **hermes** under **Everything else**, or visit `https://hermes.<configured-domain>`.
4. Sign in on Hermes's login page as `daniel` with the Glance password.
5. Open **Chat** to use the embedded Hermes terminal.

The backend stays on `127.0.0.1:9119`. Caddy uses Hatchi's existing wildcard certificate and private LAN/Tailscale ingress rules. There is no new public firewall opening. Glance includes a Hermes bookmark and a loopback health check.

The dashboard unit's `HERMES_DASHBOARD_PUBLIC_URL` declares the exact external hostname and enables native authentication even on the loopback listener. The login settings stay out of shared configuration, so the gateway keeps its separate internal loopback listener. The proxy preserves Host and Origin. Hermes protects APIs with authenticated cookies and WebSockets with single-use tickets. Glance's login alone does not protect Hermes. Dashboard sessions expire when its process restarts because Hermes generates its own signing key in memory.

The package includes compiled web and terminal assets. Startup does not install npm dependencies. Its units hide user homes, protect the system filesystem, drop capabilities, and require explicit command approval. Prompts and approvals are not an OS security boundary. Grant any additional machine or service access separately.

A restart of the shared opnix provider refetches credentials and restarts dependent applications, including Hermes. Follow the [secret rotation procedure](../tests/srv-hatchi/onepassword.md). Do not restart that provider casually.

## Verify without deployment

```sh
traitor check --no-build
nix build --no-link --print-build-logs .#checks.x86_64-linux.srv-hatchi-hermes
```

The focused check uses synthetic credentials and no model inference. It checks native-unit isolation, credential ownership, Go configuration, the Caddy route, and the Glance link. It starts the actual gateway and dashboard through their credential launchers, with the dashboard behind a real Caddy HTTPS proxy. It checks login, Secure cookies, API authorization, hostile Host and Origin rejection, one-use WebSocket tickets, missing-credential failures, session invalidation after restart, and memory persistence.

These checks do not prove production 1Password permissions, a model response, live systemd activation, or production DNS and HTTPS access. Verify those after a separately authorized deployment.
