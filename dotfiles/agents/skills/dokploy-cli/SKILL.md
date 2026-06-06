---
name: dokploy-cli
description: Use the Dokploy CLI to authenticate, inspect projects, manage apps/compose stacks/databases/domains/deployments, read logs, and sync environment configuration. Use when the user asks to work with Dokploy from the terminal.
metadata:
  short-description: Manage Dokploy from the CLI
---

# Dokploy CLI

This skill helps use the `dokploy` CLI to manage Daniel's Dokploy server from the terminal.

## Current CLI baseline

The local CLI was updated on 2026-06-06 from the old `@dokploy/cli@0.2.x` command set to the new generated CLI.

- Installed package: `@dokploy/cli@0.29.4`
- `dokploy --version` may print `0.3.0` even when the package is `0.29.4`
- The new CLI exposes hundreds of generated commands from the Dokploy API
- Prefer `--json` for machine-readable output whenever available

Useful checks:

```bash
command -v dokploy
dokploy --version
dokploy --help
npm view @dokploy/cli version
```

## Authentication

New command:

```bash
dokploy auth --url "https://dokploy.danielkumlin.com" --token "<api-key>"
# short flags also work:
dokploy auth -u "https://dokploy.danielkumlin.com" -t "<api-key>"
```

Environment variables are also supported:

```bash
export DOKPLOY_URL="https://dokploy.danielkumlin.com"
export DOKPLOY_API_KEY="<api-key>"
# DOKPLOY_AUTH_TOKEN is also accepted by the current CLI client.
```

There is no separate `verify` command in the new CLI. Verify auth by reading projects:

```bash
dokploy project all --json
```

Do not print tokens. The CLI stores auth in the package `config.json`; environment variables are safer for temporary scripting.

## Old-to-new command mapping

The old CLI had commands like `authenticate`, `verify`, `project list`, `project info`, `app ...`, `database postgres ...`, and `env pull/push`.

Use these new commands instead:

| Old command | New command |
|---|---|
| `dokploy authenticate` | `dokploy auth` |
| `dokploy verify` | `dokploy project all --json` |
| `dokploy project list` | `dokploy project all --json` |
| `dokploy project info --projectId ...` | `dokploy project one --projectId ... --json` |
| `dokploy app ...` | `dokploy application ...` |
| `dokploy database postgres ...` | `dokploy postgres ...` |
| `dokploy database redis ...` | `dokploy redis ...` |
| `dokploy database mysql ...` | `dokploy mysql ...` |
| `dokploy database mongo ...` | `dokploy mongo ...` |
| `dokploy database mariadb ...` | `dokploy mariadb ...` |
| Generic env pull/push | Use service-specific `save-environment` / `update --env`, or inspect via `one --json` |

## Daniel Kumlin defaults

Assume these defaults unless Daniel explicitly asks otherwise:

- Base Dokploy URL: `https://dokploy.danielkumlin.com`
- Base domain: `danielkumlin.com`
- Normalize project names and service names to lowercase kebab-case before building domains
- Always configure Git source for applications; creating an application alone is not enough
- Default build type is `railpack`
- If the target build path already contains an inline `Dockerfile`, use `dockerfile`
- For monorepos, prefer app-local Dockerfiles with repo-root context when Dockerfiles copy shared root files
- If there is one public app or a clear primary frontend, use `<project-name>.danielkumlin.com`
- If there are multiple public services, keep the primary frontend on `<project-name>.danielkumlin.com` and use `<service-name>.<project-name>.danielkumlin.com` for additional public services
- For frontend build-time envs such as `VITE_*`, set app `env` as well as `buildArgs` when applicable
- When scripting Dokploy API calls on Daniel's machine, prefer `uv run python` with the standard library over bare `python`
- Prefer the new CLI first; fall back to the Dokploy API/trpc only when a CLI command is missing or broken

## Safety guidelines

Read first, mutate second. Treat these as destructive and ask/confirm before using them unless Daniel has explicitly requested the exact action:

- `application delete`, `compose delete`, database `remove`, `project remove`, `environment remove`
- `domain delete`, `redirects delete`, `security delete`, `port delete`
- `settings clean-*`, `docker remove-container`, `docker kill-container`, `deployment kill-process`
- any password/secret rotation such as `*-change-password`
- `save-environment` / `update --env` if it overwrites the full remote env
- server, Traefik, Docker, Swarm, or infrastructure reload/setup/update commands

Prefer inspecting with `--json` and reading logs before redeploying or restarting.

## Common read-only inspection commands

```bash
# Projects/environments
dokploy project all --json
dokploy project one --projectId "<project-id>" --json
dokploy environment by-project-id --projectId "<project-id>" --json

# Applications
dokploy application search --q "<name>" --json
dokploy application one --applicationId "<application-id>" --json
dokploy application read-logs --applicationId "<application-id>" --tail 200

dokploy application read-traefik-config --applicationId "<application-id>" --json

# Compose stacks
dokploy compose search --q "<name>" --json
dokploy compose one --composeId "<compose-id>" --json
dokploy compose read-logs --composeId "<compose-id>" --tail 200

# Domains
dokploy domain by-application-id --applicationId "<application-id>" --json
dokploy domain by-compose-id --composeId "<compose-id>" --json
dokploy domain one --domainId "<domain-id>" --json

# Servers/settings
dokploy server all --json
dokploy settings health --json
dokploy settings get-dokploy-version --json
dokploy settings read-traefik-config --json
```

If a command's flags are uncertain, inspect first:

```bash
dokploy <group> --help
dokploy <group> <action> --help
```

## Common mutating workflows

### Create and configure an application

```bash
# 1. Find/create project and environment
dokploy project all --json
dokploy environment by-project-id --projectId "<project-id>" --json

# 2. Create the app
dokploy application create \
  --name "My App" \
  --appName "my-app" \
  --description "My app" \
  --environmentId "<environment-id>" \
  --json

# 3. Configure source/build/env
dokploy application update \
  --applicationId "<application-id>" \
  --sourceType github \
  --owner RestartDK \
  --repository "<repo>" \
  --branch main \
  --githubId "<github-provider-id>" \
  --triggerType push \
  --buildType railpack \
  --buildPath "/" \
  --env "KEY=value" \
  --buildArgs "KEY=value" \
  --json

# For Dockerfile apps add:
#   --buildType dockerfile --dockerfile "path/to/Dockerfile" --dockerContextPath "."

# 4. Attach domain
dokploy domain create \
  --host "app.danielkumlin.com" \
  --applicationId "<application-id>" \
  --domainType application \
  --port 3000 \
  --path "/" \
  --https \
  --certificateType letsencrypt \
  --json

# 5. Deploy/redeploy
dokploy application deploy --applicationId "<application-id>" --json
# or:
dokploy application redeploy --applicationId "<application-id>" --json
```

### Create/update a compose stack

```bash
dokploy compose create \
  --name "umami" \
  --appName "umami" \
  --environmentId "<environment-id>" \
  --composeType docker-compose \
  --composeFile "$(cat docker-compose.yml)" \
  --json

dokploy compose update \
  --composeId "<compose-id>" \
  --sourceType raw \
  --composeType docker-compose \
  --composeFile "$(cat docker-compose.yml)" \
  --env "APP_SECRET=..." \
  --json

dokploy domain create \
  --host "umami.danielkumlin.com" \
  --composeId "<compose-id>" \
  --domainType compose \
  --serviceName "umami" \
  --port 3000 \
  --path "/" \
  --https \
  --certificateType letsencrypt \
  --json

dokploy compose deploy --composeId "<compose-id>" --json
```

For compose domains, the `serviceName` must match the service key in the compose file.

### Update an existing domain port

```bash
dokploy domain update \
  --domainId "<domain-id>" \
  --host "danielkumlin.com" \
  --domainType application \
  --port 80 \
  --path "/" \
  --https \
  --certificateType letsencrypt \
  --json
```

After changing domains, redeploy/reload the affected service if Traefik does not pick up the route:

```bash
dokploy application redeploy --applicationId "<application-id>" --json
dokploy compose redeploy --composeId "<compose-id>" --json
```

### Database lifecycle

```bash
# Postgres
dokploy postgres create --name "postgres-main" --appName "postgres-main" --databaseName "app" --databaseUser "postgres" --databasePassword "<secret>" --environmentId "<environment-id>" --json
dokploy postgres deploy --postgresId "<postgres-id>" --json
dokploy postgres read-logs --postgresId "<postgres-id>" --tail 200
dokploy postgres stop --postgresId "<postgres-id>" --json

# Redis
dokploy redis create --name "redis-main" --appName "redis-main" --databasePassword "<secret>" --environmentId "<environment-id>" --json
dokploy redis deploy --redisId "<redis-id>" --json
```

MySQL/MariaDB/MongoDB follow the same pattern with `mysql`, `mariadb`, or `mongo` groups.

## Full command map

Generated from `dokploy --help` and `dokploy <group> --help` on 2026-06-06. Generic `help` subcommands are omitted from each group.

```text
auth
admin: setup-monitoring
ai: analyze-logs, create, delete, deploy, get, get-all, get-enabled-providers, get-models, one, suggest, test-connection, update
application: cancel-deployment, clean-queues, clear-deployments, create, delete, deploy, disconnect-git-provider, drop-deployment, kill-build, mark-running, move, one, read-app-monitoring, read-logs, read-traefik-config, redeploy, refresh-token, reload, save-bitbucket-provider, save-build-type, save-docker-provider, save-environment, save-gitea-provider, save-github-provider, save-gitlab-provider, save-git-provider, search, start, stop, update, update-traefik-config
audit-log: all
backup: create, list-backup-files, manual-backup-compose, manual-backup-libsql, manual-backup-mariadb, manual-backup-mongo, manual-backup-my-sql, manual-backup-postgres, manual-backup-web-server, one, remove, update
bitbucket: bitbucket-providers, create, get-bitbucket-branches, get-bitbucket-repositories, one, test-connection, update
certificates: all, create, one, remove, update
cluster: add-manager, add-worker, get-nodes, remove-worker
compose: cancel-deployment, clean-queues, clear-deployments, create, delete, deploy, deploy-template, disconnect-git-provider, fetch-source-type, get-converted-compose, get-default-command, get-tags, import, isolated-deployment, kill-build, load-mounts-by-service, load-services, move, one, preview-template, process-template, randomize-compose, read-logs, redeploy, refresh-token, save-environment, search, start, stop, templates, update
custom-role: all, create, get-statements, members-by-role, remove, update
deployment: all, all-by-compose, all-by-server, all-by-type, all-centralized, kill-process, queue-list, remove-deployment
destination: all, create, one, remove, test-connection, update
docker: get-config, get-containers, get-containers-by-app-label, get-containers-by-app-name-match, get-service-containers-by-app-name, get-stack-containers-by-app-name, kill-container, remove-container, restart-container, start-container, stop-container, upload-file-to-container
domain: by-application-id, by-compose-id, can-generate-traefik-me-domains, create, delete, generate-domain, one, update, validate-domain
environment: by-project-id, create, duplicate, one, remove, search, update
gitea: create, get-gitea-branches, get-gitea-repositories, get-gitea-url, gitea-providers, one, test-connection, update
github: get-github-branches, get-github-repositories, github-providers, one, test-connection, update
gitlab: create, get-gitlab-branches, get-gitlab-repositories, gitlab-providers, one, test-connection, update
git-provider: all-for-permissions, get-all, remove, toggle-share
libsql: change-status, create, deploy, move, one, read-logs, rebuild, reload, remove, save-environment, save-external-ports, start, stop, update
license-key: activate, deactivate, get-enterprise-settings, have-valid-license-key, update-enterprise-settings, validate
mariadb: change-password, change-status, create, deploy, move, one, read-logs, rebuild, reload, remove, save-environment, save-external-port, search, start, stop, update
mongo: change-password, change-status, create, deploy, move, one, read-logs, rebuild, reload, remove, save-environment, save-external-port, search, start, stop, update
mounts: all-named-by-application-id, create, list-by-service-id, one, remove, update
mysql: change-password, change-status, create, deploy, move, one, read-logs, rebuild, reload, remove, save-environment, save-external-port, search, start, stop, update
notification: all, create-custom, create-discord, create-email, create-gotify, create-lark, create-mattermost, create-ntfy, create-pushover, create-resend, create-slack, create-teams, create-telegram, get-email-providers, one, receive-notification, remove, test-custom-connection, test-discord-connection, test-email-connection, test-gotify-connection, test-lark-connection, test-mattermost-connection, test-ntfy-connection, test-pushover-connection, test-resend-connection, test-slack-connection, test-teams-connection, test-telegram-connection, update-custom, update-discord, update-email, update-gotify, update-lark, update-mattermost, update-ntfy, update-pushover, update-resend, update-slack, update-teams, update-telegram
organization: active, all, all-invitations, create, delete, invite-member, one, remove-invitation, set-default, update, update-member-role
patch: by-entity-id, clean-patch-repos, create, delete, ensure-repo, mark-file-for-deletion, one, read-repo-directories, read-repo-file, save-file-as-patch, toggle-enabled, update
port: create, delete, one, update
postgres: change-password, change-status, create, deploy, move, one, read-logs, rebuild, reload, remove, save-environment, save-external-port, search, start, stop, update
preview-deployment: all, delete, one, redeploy
project: all, all-for-permissions, create, duplicate, home-stats, one, remove, search, update
redirects: create, delete, one, update
redis: change-password, change-status, create, deploy, move, one, read-logs, rebuild, reload, remove, save-environment, save-external-port, search, start, stop, update
registry: all, create, one, remove, test-registry, test-registry-by-id, update
rollback: delete, rollback
schedule: create, delete, list, one, run-manually, update
security: create, delete, one, update
server: all, all-for-permissions, build-servers, count, create, get-default-command, get-server-metrics, get-server-time, one, public-ip, remove, security, setup, setup-monitoring, update, validate, with-sshkey
settings: assign-domain-server, check-gpustatus, check-infrastructure-health, clean-all, clean-all-deployment-queue, clean-docker-builder, clean-docker-prune, clean-monitoring, clean-redis, clean-sshprivate-key, clean-stopped-containers, clean-unused-images, clean-unused-volumes, get-docker-disk-usage, get-dokploy-cloud-ips, get-dokploy-version, get-ip, get-log-cleanup-status, get-open-api-document, get-release-tag, get-traefik-ports, get-update-data, get-web-server-settings, have-activate-requests, have-traefik-dashboard-port-enabled, health, is-cloud, is-user-subscribed, read-directories, read-middleware-traefik-config, read-traefik-config, read-traefik-env, read-traefik-file, read-web-server-traefik-config, reload-redis, reload-server, reload-traefik, save-sshprivate-key, setup-gpu, toggle-dashboard, toggle-requests, update-docker-cleanup, update-log-cleanup, update-middleware-traefik-config, update-server, update-server-ip, update-traefik-config, update-traefik-file, update-traefik-ports, update-web-server-traefik-config, write-traefik-env
ssh-key: all, all-for-apps, create, generate, one, remove, update
sso: add-trusted-origin, delete-provider, get-trusted-origins, list-providers, one, register, remove-trusted-origin, show-sign-in-with-sso, update, update-trusted-origin
stripe: can-create-more-servers, create-checkout-session, create-customer-portal-session, get-current-plan, get-invoices, get-products, update-invoice-notifications, upgrade-subscription
swarm: get-container-stats, get-node-apps, get-node-info, get-nodes
tag: all, assign-to-project, bulk-assign, create, one, remove, remove-from-project, update
user: all, assign-permissions, check-user-organizations, create-api-key, create-user-with-credentials, delete-api-key, generate-token, get, get-backups, get-bookmarked-templates, get-container-metrics, get-invitations, get-metrics-token, get-permissions, get-server-metrics, get-user-by-token, have-root-access, one, remove, send-invitation, session, toggle-template-bookmark, update
volume-backups: create, delete, list, one, run-manually, update
whitelabeling: get, get-public, reset, update
```

## Local helper scripts

This skill still includes helper files for Daniel-style stack creation:

- `scripts/create_stack_from_service_map.py`
- `reference/service-map.example.json`

Use them from the skill directory when a whole project stack should be created from a service map. They use direct Dokploy API/trpc calls and may need maintenance if Dokploy API payloads change; prefer the CLI for one-off operations.

```bash
cd /Users/danielkumlin/.pi/agent/skills/dokploy-cli
export DOKPLOY_URL="https://dokploy.danielkumlin.com"
export DOKPLOY_API_KEY="<api-key>"
uv run python scripts/create_stack_from_service_map.py reference/service-map.example.json --repo-root /path/to/repo
```

## Tips

1. Use `dokploy <group> <action> --help` because generated commands expose all required option names.
2. Add `--json` for parsing, but avoid printing secret-bearing fields in final responses.
3. When a domain returns Traefik default cert/404, inspect `domain ...`, service Traefik config, and redeploy/reload the affected app/compose if needed.
4. When an app returns 502, verify the domain `--port` matches the container listener (static Caddy apps often listen on `80`; Node apps often listen on `3000`).
5. If the CLI output is insufficient, use the API/trpc as a fallback with `uv run python`, never exposing tokens.
