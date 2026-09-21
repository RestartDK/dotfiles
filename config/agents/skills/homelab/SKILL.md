---
name: homelab
description: Use when Daniel asks to manage, edit, troubleshoot, deploy, or improve his homelab. Loads the homelab repo, follows Hachi/Nana host context, handles Podman/Docker Compose, Caddy, AdGuard, Tailscale, Fedora, services, and safe live-ops workflows.
---

# Homelab Skill

Use this skill whenever Daniel asks about his homelab, home server, self-hosted services, Hachi, Nana, Caddy, AdGuard, Podman/Docker Compose stacks, Tailscale access, monitoring, media services, OpenCode, Ollama, Portainer, Dokploy, or related infrastructure.

## Source of truth

The durable source of truth is the repo, not model memory:

```text
/Users/danielkumlin/Projects/homelab
```

When this skill is used:

1. Open or inspect `/Users/danielkumlin/Projects/homelab`.
2. Read `AGENTS.md` first.
3. Read `README.md` and any relevant service/config files.
4. Run `git status --short --branch` before edits.
5. Never assume live infrastructure state without inspecting files or the relevant host.

## Current host model

- **Hachi** is the primary homelab server: a laptop running Fedora Server. It runs the main root `docker-compose.yml` stack, currently expected to use Podman / Podman Compose. It hosts Caddy, AdGuard Home, dashboard/media/productivity/monitoring services, and proxies some services from Nana.
- **Nana** is Daniel's normal workstation/dev environment: Fedora 43. Its config is under `srv-nana/`. It runs dev/AI services such as Ollama and OpenCode-related setup, generally with Docker/Docker Compose/Swarm where documented.
- Both machines are connected through Tailscale.

## Interaction workflow

Classify the request before acting:

1. **Repo edit** — change config/scripts/docs only. Make precise edits, validate, summarize deploy impact.
2. **Live operation** — SSH, check logs, restart/deploy services, inspect containers, DNS, or host state. Start read-only. Ask before disruptive actions.
3. **Design/planning** — propose architecture improvements, migration paths, runbooks, security hardening, backups, monitoring, or automation.
4. **Troubleshooting** — gather symptoms, inspect relevant config, use read-only commands first, then propose fixes.

## Safety rules

- Do not print, commit, or fabricate secrets.
- Do not deploy/restart/stop services unless Daniel asks or confirms.
- Ask before deleting volumes, pruning containers/images, changing firewall/router/DNS settings, reinitializing networks, rotating credentials, or changing exposed ports.
- Explain expected downtime and rollback for risky changes.
- Prefer minimal reversible changes.
- If hostnames like `hachi`/`nana` or paths like `/opt/homelab` fail, ask for the correct access details.

## Common homelab change checklist

For adding or changing a web service on Hachi, consider:

- root `docker-compose.yml` service definition;
- external `caddynet` membership if proxied by Caddy;
- SELinux volume labels (`:Z` / `:z`) and persistent volumes;
- env var names for host/container ports and secrets;
- `Caddyfile` reverse proxy block;
- AdGuard DNS rewrite/manual note for the subdomain;
- Glance dashboard labels or config;
- README/runbook update if needed;
- validation with Podman/Docker Compose config and Caddy validation where available.

For Nana changes, inspect `srv-nana/README.md`, `srv-nana/docker-compose.yml`, and relevant systemd/Dokploy/Portainer files before editing.

## Response style

Be operationally careful and concise. State:

- what files were inspected/changed;
- whether the change affects Hachi, Nana, or both;
- whether live deployment was performed;
- exact next commands Daniel can run if deployment is still pending.
