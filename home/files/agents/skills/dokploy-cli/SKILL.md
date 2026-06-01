---
name: dokploy-cli
description: Use the Dokploy CLI to authenticate, inspect projects, manage apps and databases, and sync environment variables. Use when the user asks to work with Dokploy from the terminal.
metadata:
  short-description: Manage Dokploy from the CLI
---

# Dokploy CLI

This skill helps you use the `dokploy` CLI to manage a Dokploy server from the terminal.

## When to Use This Skill

Use this skill when the user:

- Wants to authenticate to Dokploy from the CLI
- Needs to list or inspect Dokploy projects
- Wants to create, deploy, stop, or delete applications
- Wants to create, deploy, stop, or delete managed databases
- Needs to pull or push environment variables for a service
- Asks for Dokploy terminal commands or workflows

## What is the Dokploy CLI?

The Dokploy CLI (`dokploy`) is a command-line interface for managing a Dokploy server remotely.

It can be used for:

- Authentication
- Project management
- Application management
- Database management
- Environment variable sync

**Key commands:**

- `dokploy authenticate` - Save Dokploy server URL and token
- `dokploy verify` - Verify saved authentication
- `dokploy project list` - List projects
- `dokploy project info` - Show project details
- `dokploy app create|deploy|stop|delete` - Manage apps
- `dokploy database <type> <action>` - Manage databases
- `dokploy env pull|push` - Sync environment variables

**Docs:** `https://docs.dokploy.com/docs/cli`

## Daniel Kumlin Defaults

This local copy of the skill should assume the following personal defaults unless Daniel explicitly asks for something else:

- Base domain is always `danielkumlin.com`
- Normalize project names and service names to lowercase kebab-case before building domains
- Always configure the Git source for applications; `app create` by itself is not a complete deployment setup
- Default build type is `railpack`
- If the target build path already contains an inline `Dockerfile`, use build type `dockerfile` instead
- For monorepos, prefer app-local Dockerfiles with repo-root context when the Dockerfile copies shared root files
- If there is one public app or a clear primary frontend, use `<project-name>.danielkumlin.com`
- If there are multiple public services, keep the primary frontend on `<project-name>.danielkumlin.com` and use `<service-name>.<project-name>.danielkumlin.com` for every additional public service
- When attaching domains, prefer creating them with `applicationId`; if a domain exists without `applicationId`, delete and recreate it instead of trying to patch `serviceName`
- For frontend build-time envs such as `VITE_*`, set app `env` as well as build args when applicable, since Railpack/Vite may not pick up build args alone
- When scripting Dokploy API calls on Daniel's machine, prefer `uv run python` with the standard library over bare `python`

## How to Help Users with Dokploy

### Step 1: Confirm the CLI is Available

Check that `dokploy` is installed:

```bash
command -v dokploy
dokploy --version
```

### Step 2: Confirm Authentication

Most Dokploy commands require authentication.

Authenticate with a URL and token:

```bash
dokploy authenticate --url "https://your-dokploy.example.com" --token "your-token"
```

Then verify access:

```bash
dokploy verify
```

The CLI also supports environment-based auth:

```bash
export DOKPLOY_URL="https://your-dokploy.example.com"
export DOKPLOY_AUTH_TOKEN="your-token"
```

### Step 3: Read Current State First

Before mutating anything, inspect the user's projects:

```bash
dokploy project list
dokploy project info --projectId "project-id"
```

Use project info to understand what apps and databases already exist.

### Step 4: Run the Requested Workflow

Use the right command group for the user's task:

- `project` for creating and inspecting projects
- `app` for application lifecycle actions
- `database` for managed database lifecycle actions
- `env` for environment variable sync

### Step 5: Prefer Full App Setup Over Bare App Creation

The installed `dokploy` CLI can create and deploy apps, but it does not fully configure source control, build settings, or domains in this version.

For a real deployment workflow, treat `dokploy app create` as only the first step, then configure the app through Dokploy's API:

- Use `application.update` to set:
  - `sourceType`
  - `owner`
  - `repository`
  - `branch`
  - `buildPath`
  - `githubId` or the relevant provider ID
  - `buildType`
  - `dockerfile` and `dockerContextPath` for Dockerfile apps
  - `env` and `buildArgs`
- Use `domain.create` to attach domains to the application
- Use `application.deploy` only after the source, build, env, and domains are configured

For Daniel-specific deployments, the preferred application setup order is:

1. Create the app or database if it does not exist
2. Configure the Git repo and branch
3. Choose build type: `railpack` by default, `dockerfile` only when the app path already contains a Dockerfile
4. Configure app env and build args
5. Attach domains using the `danielkumlin.com` naming convention
6. Deploy and verify the public URL

### Step 6: Use `uv run python` Templates For Full Setup

When the stock CLI cannot finish the setup, prefer `uv run python` API helpers instead of ad hoc `python` snippets.

Recommended environment variables:

```bash
export DOKPLOY_URL="https://dokploy.danielkumlin.com"
export DOKPLOY_AUTH_TOKEN="your-token"
```

Create the app first with the CLI:

```bash
dokploy app create --projectId "project-id" --name "Flox Backend API" --appName "backend-fastapi" --description "FastAPI backend" --skipConfirm
```

Then configure repo, build type, env, domain, and deploy with `uv run python`:

```bash
uv run python - <<'PY'
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

BASE = os.environ["DOKPLOY_URL"].rstrip("/") + "/api/trpc/"
HEADERS = {
    "x-api-key": os.environ["DOKPLOY_AUTH_TOKEN"],
    "Content-Type": "application/json",
}


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def trpc_get(path: str, payload: dict):
    params = urllib.parse.urlencode({"input": json.dumps({"json": payload})})
    req = urllib.request.Request(BASE + path + "?" + params, headers=HEADERS)
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)["result"]["data"]["json"]


def trpc_post(path: str, payload: dict):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps({"json": payload}).encode(),
        headers=HEADERS,
    )
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)["result"]["data"]["json"]


project_name = "Flox"
service_name = "backend-fastapi"
application_id = "replace-with-application-id"
owner = "RestartDK"
repository = "flox"
branch = "main"
service_path = "apps/backend/fastapi"
port = 5000
env = "DATABASE_URL=${{project.DATABASE_URL}}\nML_URL=${{project.ML_URL}}"
build_args = ""

project_slug = slugify(project_name)
service_slug = slugify(service_name)
is_primary_public_service = service_slug in {"web", "webapp", "frontend", "app"}
domain = (
    f"{project_slug}.danielkumlin.com"
    if is_primary_public_service
    else f"{service_slug}.{project_slug}.danielkumlin.com"
)

inline_dockerfile = Path(service_path, "Dockerfile").exists()
build_type = "dockerfile" if inline_dockerfile else "railpack"
build_path = "/" if inline_dockerfile else f"./{service_path}"

update_payload = {
    "applicationId": application_id,
    "sourceType": "github",
    "owner": owner,
    "repository": repository,
    "branch": branch,
    "githubId": "replace-with-github-provider-id",
    "triggerType": "push",
    "watchPaths": [],
    "enableSubmodules": False,
    "buildType": build_type,
    "buildPath": build_path,
    "env": env,
    "buildArgs": build_args,
}

if build_type == "dockerfile":
    update_payload["dockerfile"] = f"{service_path}/Dockerfile"
    update_payload["dockerContextPath"] = "."

trpc_post("application.update", update_payload)
trpc_post(
    "domain.create",
    {
        "host": domain,
        "applicationId": application_id,
        "port": port,
        "path": "/",
        "https": True,
        "certificateType": "letsencrypt",
    },
)
trpc_post("application.deploy", {"applicationId": application_id})

print(json.dumps({
    "applicationId": application_id,
    "buildType": build_type,
    "buildPath": build_path,
    "domain": domain,
}, indent=2))
PY
```

Daniel-specific template notes:

- Keep `railpack` as the default when there is no inline Dockerfile in the app path
- Switch to `dockerfile` automatically when `service_path/Dockerfile` exists
- For Dockerfile apps in monorepos, use `dockerContextPath = "."` unless the Dockerfile is fully self-contained inside the app folder
- For Vite frontends, set both `env` and `buildArgs`, for example:

```text
env = "VITE_BACKEND_URL=${{project.VITE_BACKEND_URL}}"
build_args = "VITE_BACKEND_URL=${{project.VITE_BACKEND_URL}}"
```

- If a domain already exists but is orphaned or attached without `applicationId`, delete it first with `domain.delete`, then recreate it with `domain.create`

### Step 7: Create A Whole Project Stack From A Service Map

For Daniel's recurring setups, use the bundled whole-stack helper instead of repeating one-off API snippets.

Files bundled with this skill:

- `scripts/create_stack_from_service_map.py`
- `reference/service-map.example.json`

Run it with `uv run python` from the skill directory:

```bash
export DOKPLOY_URL="https://dokploy.danielkumlin.com"
export DOKPLOY_AUTH_TOKEN="your-token"

uv run python scripts/create_stack_from_service_map.py reference/service-map.example.json --repo-root /path/to/repo
```

What the helper does:

- reads the target project and environment
- creates missing `application`, `postgres`, and `redis` services
- always configures the Git repo, branch, provider, and build path
- defaults to `railpack`
- switches to `dockerfile` automatically when `service_path/Dockerfile` exists
- creates domains using Daniel's convention:
  - primary public app: `<project-name>.danielkumlin.com`
  - other public services: `<service-name>.<project-name>.danielkumlin.com`
- recreates conflicting/orphaned domains when needed
- deploys the stack in the `deployOrder` from the service map

If you only want to create and configure resources without deploying them yet:

```bash
uv run python scripts/create_stack_from_service_map.py reference/service-map.example.json --repo-root /path/to/repo --skip-deploy
```

## Common Workflows

### Authentication

```bash
dokploy authenticate --url "https://your-dokploy.example.com" --token "your-token"
dokploy verify
```

If flags are omitted, `dokploy authenticate` prompts interactively:

```bash
dokploy authenticate
```

### Projects

List projects:

```bash
dokploy project list
```

Show project details:

```bash
dokploy project info --projectId "project-id"
```

Create a project:

```bash
dokploy project create --name "My Project" --description "Project description" --skipConfirm
```

### Applications

Create an app:

```bash
dokploy app create --projectId "project-id" --name "Frontend" --appName "frontend" --description "Main web app" --skipConfirm
```

Deploy an app:

```bash
dokploy app deploy --applicationId "application-id" --skipConfirm
```

Stop an app:

```bash
dokploy app stop --applicationId "application-id" --skipConfirm
```

Delete an app:

```bash
dokploy app delete --applicationId "application-id" --skipConfirm
```

If the user does not know the app ID, inspect the project first with `dokploy project info` or let the CLI prompt interactively.

Daniel-style application setup defaults:

- **Git source**: always set the connected Git provider, owner, repository, branch, and build path after app creation
- **Build selection**:
  - use `railpack` unless the app directory already has a `Dockerfile`
  - use `dockerfile` when an inline Dockerfile exists in the target service directory
- **Domains**:
  - single public app or primary frontend: `<project-name>.danielkumlin.com`
  - additional public services: `<service-name>.<project-name>.danielkumlin.com`
- **Frontend env**: if the app is a Vite frontend, set `VITE_*` values in app env, and also in build args when supported

In practice, that means the deployment workflow is usually:

1. `dokploy app create`
2. `application.update` via the API to set repo + branch + build config
3. `domain.create` via the API to attach the correct domain
4. `dokploy app deploy`

### Environment Variables

Pull environment variables to a local file:

```bash
dokploy env pull .env.stage.local
```

Push a local env file to Dokploy:

```bash
dokploy env push .env.stage.local
```

### Databases

The installed CLI supports these database types:

- `mariadb`
- `mongo`
- `mysql`
- `postgres`
- `redis`

Each type supports `create`, `deploy`, `stop`, and `delete` commands.

MariaDB example:

```bash
dokploy database mariadb create --projectId "project-id" --name "mariadb-main" --databaseName "appdb" --databaseUser "mariadb" --databasePassword "secret" --databaseRootPassword "root-secret" --appName "mariadb-main" --skipConfirm

dokploy database mariadb deploy --mariadbId "mariadb-id" --skipConfirm
dokploy database mariadb stop --mariadbId "mariadb-id" --skipConfirm
dokploy database mariadb delete --mariadbId "mariadb-id" --skipConfirm
```

Postgres example:

```bash
dokploy database postgres create --projectId "project-id" --name "postgres-main" --databaseName "appdb" --databaseUser "postgres" --databasePassword "secret" --appName "postgres-main" --skipConfirm

dokploy database postgres deploy --postgresId "postgres-id" --skipConfirm
dokploy database postgres stop --postgresId "postgres-id" --skipConfirm
dokploy database postgres delete --postgresId "postgres-id" --skipConfirm
```

MySQL example:

```bash
dokploy database mysql create --projectId "project-id" --name "mysql-main" --databaseName "appdb" --databaseUser "mysql" --databasePassword "secret" --databaseRootPassword "root-secret" --appName "mysql-main" --skipConfirm

dokploy database mysql delete --mysqlId "mysql-id" --skipConfirm
```

Mongo example:

```bash
dokploy database mongo create --projectId "project-id" --name "mongo-main" --databaseName "appdb" --databaseUser "mongo" --databasePassword "secret" --appName "mongo-main" --skipConfirm

dokploy database mongo deploy --mongoId "mongo-id" --skipConfirm
dokploy database mongo stop --mongoId "mongo-id" --skipConfirm
dokploy database mongo delete --mongoId "mongo-id" --skipConfirm
```

Redis example:

```bash
dokploy database redis create --projectId "project-id" --name "redis-main" --databasePassword "secret" --appName "redis-main" --skipConfirm

dokploy database redis deploy --redisId "redis-id" --skipConfirm
dokploy database redis stop --redisId "redis-id" --skipConfirm
dokploy database redis delete --redisId "redis-id" --skipConfirm
```

## Important Notes

- `dokploy env push` overwrites the full remote environment for the selected service.
- In the installed CLI, the command names are `mongo` and `postgres`, even if docs elsewhere say `mongodb` or `postgresql`.
- Some commands prompt interactively when IDs are omitted.
- This CLI version does not expose dedicated `app list` or `app info` commands.
- This CLI version also does not fully configure repo source, build type, Dockerfile path, app env, or domains; use the Dokploy API for those steps.
- In this environment, `dokploy project info` may be incomplete or buggy; if needed, query `project.one` through the API instead.
- Railpack deployments for Vite apps may require app-level env vars in addition to build args for values like `VITE_BACKEND_URL`.
- Domain creation works best when created directly with `applicationId`; recreating a broken/orphaned domain is often more reliable than patching it.
- The installed CLI stores auth in its package `config.json`, so environment variables can be safer for scripted or temporary usage.

## Safety Guidelines

Treat these as destructive and confirm intent before running them:

- `dokploy app delete`
- `dokploy database <type> delete`
- `dokploy env push`

Prefer to inspect projects first before mutating resources.

## Tips for Effective Usage

1. Use `dokploy project list` and `dokploy project info` before making changes.
2. Prefer explicit IDs for non-interactive runs.
3. If a command seems stuck, it may be waiting on an interactive prompt.
4. If the docs and local CLI disagree, prefer the installed CLI help.

## When Commands Do Not Match the Docs

If the user asks for a Dokploy command that seems missing:

1. Check `dokploy --help`
2. Check the relevant subcommand help, like `dokploy app --help` or `dokploy database postgres --help`
3. Use the installed CLI behavior as the source of truth

Example:

```bash
dokploy --help
dokploy project --help
dokploy app --help
dokploy database --help
```
