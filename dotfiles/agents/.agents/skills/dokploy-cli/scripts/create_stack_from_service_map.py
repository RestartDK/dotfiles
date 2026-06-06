#!/usr/bin/env python3
"""Create or update a Dokploy project stack from a JSON service map.

Usage:
  export DOKPLOY_URL="https://dokploy.danielkumlin.com"
  export DOKPLOY_AUTH_TOKEN="..."
  uv run python scripts/create_stack_from_service_map.py reference/service-map.example.json --repo-root /path/to/repo
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


class DokployClient:
    def __init__(self, base_url: str, auth_token: str) -> None:
        self.base_url = base_url.rstrip("/") + "/api/trpc/"
        self.headers = {
            "x-api-key": auth_token,
            "Content-Type": "application/json",
        }

    def get(self, path: str, payload: dict[str, Any] | None = None) -> Any:
        url = self.base_url + path
        if payload is not None:
            params = urllib.parse.urlencode({"input": json.dumps({"json": payload})})
            url = f"{url}?{params}"
        req = urllib.request.Request(url, headers=self.headers)
        return self._read(req)

    def post(self, path: str, payload: dict[str, Any]) -> Any:
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps({"json": payload}).encode(),
            headers=self.headers,
        )
        return self._read(req)

    @staticmethod
    def _decode_error(exc: urllib.error.HTTPError) -> str:
        try:
            return exc.read().decode()
        except Exception:
            return str(exc)

    def _read(self, req: urllib.request.Request) -> Any:
        try:
            with urllib.request.urlopen(req) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(self._decode_error(exc)) from exc
        return data["result"]["data"]["json"]


def slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def titleize_slug(value: str) -> str:
    return " ".join(part.capitalize() for part in slugify(value).split("-"))


def env_string(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return "\n".join(f"{key}={value[key]}" for key in value)
    if isinstance(value, list):
        return "\n".join(str(item) for item in value)
    raise TypeError(f"Unsupported env/buildArgs value: {type(value)!r}")


def determine_domain(
    project_name: str, service: dict[str, Any], public_services: list[dict[str, Any]]
) -> str | None:
    if service.get("public") is not True:
        return None
    if service.get("domain"):
        return str(service["domain"])

    project_slug = slugify(project_name)
    service_slug = slugify(service["name"])
    primary_names = {"web", "webapp", "frontend", "app"}
    is_primary = bool(service.get("primary"))
    if len(public_services) == 1 or is_primary or service_slug in primary_names:
        return f"{project_slug}.danielkumlin.com"
    return f"{service_slug}.{project_slug}.danielkumlin.com"


def load_service_map(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def create_application(
    client: DokployClient,
    environment_id: str,
    service: dict[str, Any],
) -> dict[str, Any]:
    display_name = service.get("displayName") or titleize_slug(service["name"])
    description = service.get("description") or display_name
    return client.post(
        "application.create",
        {
            "name": display_name,
            "appDescription": description,
            "appName": slugify(service.get("appName") or service["name"]),
            "environmentId": environment_id,
        },
    )


def create_postgres(
    client: DokployClient,
    environment_id: str,
    service: dict[str, Any],
) -> dict[str, Any]:
    if not service.get("databasePassword"):
        raise ValueError(f"Postgres service '{service['name']}' needs databasePassword")
    return client.post(
        "postgres.create",
        {
            "name": service.get("displayName") or titleize_slug(service["name"]),
            "description": service.get("description") or titleize_slug(service["name"]),
            "databaseName": service.get("databaseName", "app"),
            "databaseUser": service.get("databaseUser", "postgres"),
            "databasePassword": service["databasePassword"],
            "dockerImage": service.get("dockerImage", "postgres:15"),
            "appName": slugify(service.get("appName") or service["name"]),
            "environmentId": environment_id,
        },
    )


def create_redis(
    client: DokployClient,
    environment_id: str,
    service: dict[str, Any],
) -> dict[str, Any]:
    if not service.get("databasePassword"):
        raise ValueError(f"Redis service '{service['name']}' needs databasePassword")
    return client.post(
        "redis.create",
        {
            "name": service.get("displayName") or titleize_slug(service["name"]),
            "description": service.get("description") or titleize_slug(service["name"]),
            "databasePassword": service["databasePassword"],
            "dockerImage": service.get("dockerImage", "redis:7"),
            "appName": slugify(service.get("appName") or service["name"]),
            "environmentId": environment_id,
        },
    )


def configure_application(
    client: DokployClient,
    repo_root: Path,
    project: dict[str, Any],
    service: dict[str, Any],
    application_id: str,
) -> dict[str, Any]:
    service_path = str(service["path"]).strip("/")
    inline_dockerfile = Path(repo_root, service_path, "Dockerfile").exists()
    build_type = service.get("buildType") or (
        "dockerfile" if inline_dockerfile else "railpack"
    )
    build_path = service.get("buildPath") or (
        "/" if build_type == "dockerfile" else f"./{service_path}"
    )

    payload: dict[str, Any] = {
        "applicationId": application_id,
        "name": service.get("displayName") or titleize_slug(service["name"]),
        "description": service.get("description") or titleize_slug(service["name"]),
        "sourceType": "github",
        "owner": project["owner"],
        "repository": project["repository"],
        "branch": project.get("branch", "main"),
        "githubId": project["githubId"],
        "triggerType": service.get("triggerType", "push"),
        "watchPaths": service.get("watchPaths", []),
        "enableSubmodules": bool(service.get("enableSubmodules", False)),
        "buildType": build_type,
        "buildPath": build_path,
        "env": env_string(service.get("env")),
        "buildArgs": env_string(service.get("buildArgs")),
    }

    command = service.get("command")
    if command:
        payload["command"] = command

    if build_type == "dockerfile":
        payload["dockerfile"] = (
            service.get("dockerfile") or f"{service_path}/Dockerfile"
        )
        payload["dockerContextPath"] = service.get("dockerContextPath", ".")

    return client.post("application.update", payload)


def ensure_domain(
    client: DokployClient,
    project_name: str,
    service: dict[str, Any],
    application_id: str,
    public_services: list[dict[str, Any]],
    all_domains: list[dict[str, Any]],
) -> str | None:
    domain = determine_domain(project_name, service, public_services)
    if domain is None:
        return None
    if not service.get("port"):
        raise ValueError(f"Public service '{service['name']}' needs a port")

    matching = [item for item in all_domains if item.get("host") == domain]
    correct = next(
        (
            item
            for item in matching
            if item.get("applicationId") == application_id
            and item.get("port") == service["port"]
        ),
        None,
    )
    if correct:
        return domain

    for item in matching:
        client.post("domain.delete", {"domainId": item["domainId"]})

    client.post(
        "domain.create",
        {
            "host": domain,
            "applicationId": application_id,
            "port": service["port"],
            "path": service.get("pathPrefix", "/"),
            "https": bool(service.get("https", True)),
            "certificateType": service.get("certificateType", "letsencrypt"),
        },
    )
    return domain


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("service_map", type=Path)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--skip-deploy", action="store_true")
    args = parser.parse_args()

    dokploy_url = os.environ.get("DOKPLOY_URL")
    dokploy_auth_token = os.environ.get("DOKPLOY_AUTH_TOKEN")
    if not dokploy_url or not dokploy_auth_token:
        raise SystemExit("DOKPLOY_URL and DOKPLOY_AUTH_TOKEN must be set")

    config = load_service_map(args.service_map)
    project = config["project"]
    services = config["services"]
    repo_root = args.repo_root.resolve()

    client = DokployClient(dokploy_url, dokploy_auth_token)
    project_info = client.get("project.one", {"projectId": project["id"]})
    environment = project_info["environments"][0]
    environment_id = environment["environmentId"]

    existing_apps = {
        item["appName"]: item for item in environment.get("applications", [])
    }
    existing_postgres = {
        item["appName"]: item for item in environment.get("postgres", [])
    }
    existing_redis = {item["appName"]: item for item in environment.get("redis", [])}
    try:
        all_domains = client.get("domain.all")
    except Exception:
        all_domains = []

    created_ids: dict[str, dict[str, Any]] = {}
    public_services = [service for service in services if service.get("public") is True]

    for service in services:
        kind = service["kind"]
        app_name = slugify(service.get("appName") or service["name"])

        if kind in {"app", "application"}:
            app = existing_apps.get(app_name)
            if app is None:
                app = create_application(client, environment_id, service)
            application_id = app["applicationId"]
            configure_application(client, repo_root, project, service, application_id)
            domain = ensure_domain(
                client,
                project["name"],
                service,
                application_id,
                public_services,
                all_domains,
            )
            created_ids[service["name"]] = {
                "kind": "application",
                "id": application_id,
                "domain": domain,
                "buildType": service.get("buildType"),
            }
            continue

        if kind == "postgres":
            resource = existing_postgres.get(app_name)
            if resource is None:
                resource = create_postgres(client, environment_id, service)
            created_ids[service["name"]] = {
                "kind": "postgres",
                "id": resource["postgresId"],
            }
            continue

        if kind == "redis":
            resource = existing_redis.get(app_name)
            if resource is None:
                resource = create_redis(client, environment_id, service)
            created_ids[service["name"]] = {"kind": "redis", "id": resource["redisId"]}
            continue

        raise ValueError(f"Unsupported service kind: {kind!r}")

    if not args.skip_deploy:
        deploy_order = config.get("deployOrder") or [
            service["name"] for service in services
        ]
        for name in deploy_order:
            item = created_ids[name]
            if item["kind"] == "application":
                client.post("application.deploy", {"applicationId": item["id"]})
            elif item["kind"] == "postgres":
                client.post("postgres.deploy", {"postgresId": item["id"]})
            elif item["kind"] == "redis":
                client.post("redis.deploy", {"redisId": item["id"]})

    print(json.dumps(created_ids, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
