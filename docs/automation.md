# Automation identity

## The identity

Unattended work on this repository runs as `restartdk-bot`, a GitHub account separate from Daniel's personal account. The account does not exist yet. Daniel creates it during the migration below.

The identity owns one credential, the fine-grained token described here. It holds no other access to the repository.

The separation buys two things. Automated commits and pull requests never appear to come from Daniel, and revoking a leaked automation token never touches his personal account or its other repositories.

Interactive agent sessions use Daniel's own account. They never use the automation token.

## Token scopes

The token is a fine-grained personal access token. Its repository access is limited to `RestartDK/dotfiles`, with these permissions:

- Contents: read and write
- Pull requests: read and write
- Metadata: read

Set an expiry date on the token and rotate it before that date. Grant no other permission.

The token carries no `Workflows` permission. GitHub requires that permission to create or update a file under `.github/workflows/`, so without it the identity cannot change CI even if it tries. Workflow changes stay in Daniel's own pull requests.

## The secret

The token lives in the repository secret `FLAKE_UPDATE_TOKEN`. `.github/workflows/update-flake-lock.yml` passes it as the `token` input to `peter-evans/create-pull-request`, so the update pull requests and their commits come from `restartdk-bot`.

The workflow runs on a schedule, Mondays at 06:17 UTC, and on manual dispatch.

## Rotation

1. Sign in as `restartdk-bot` and create a new fine-grained token with the scopes above.
2. Sign in as `RestartDK` and open the repository secrets settings. Replace the value of `FLAKE_UPDATE_TOKEN` with the new token.
3. Revoke the old token from the `restartdk-bot` account.
4. Run the `Update flake lock` workflow from the Actions tab and confirm it opens a pull request authored by `restartdk-bot`.

Only Daniel merges that pull request.

## What the identity must never hold

- Administration permission on `RestartDK/dotfiles`.
- Any secret from the GitHub `deploy` environment.
- Any SSH private key.
- The runner registration token on the host.

The `deploy` environment holds `TS_OAUTH_CLIENT_ID`, `TS_AUDIENCE`, and `SSH_PRIVATE_KEY`. [deployment.md](deployment.md) documents how the deploy workflow uses them.

The LAN runner registration token is a fine-grained token with `Administration: read and write` on `RestartDK/dotfiles`. It stays in `/var/lib/gh-runner/token` on the host, because the ephemeral runner re-registers for every job. The automation identity does not get this token.

The CI jobs read the private flake input through a separate repository secret, `DOTFILES_PRIVATE_TOKEN`. That secret stays with CI.

## The migration

`FLAKE_UPDATE_TOKEN` currently holds Daniel's personal token. The scheduled workflow therefore commits and opens pull requests as Daniel. Move the secret to the automation identity:

1. Create the `restartdk-bot` GitHub account.
2. Sign in as `restartdk-bot` and create the fine-grained token with the scopes above.
3. Sign in as `RestartDK` and replace the value of `FLAKE_UPDATE_TOKEN` with the new token.
4. Revoke Daniel's personal token that held the secret.
5. Run `Update flake lock` from the Actions tab. Confirm the pull request is authored by `restartdk-bot`, then merge it.

Nothing else in `.github/workflows/update-flake-lock.yml` changes. The branch name, the commit message, the title, and the schedule stay as they are.
