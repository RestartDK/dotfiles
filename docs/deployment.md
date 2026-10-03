# Deployment

Every pull request and `main` push runs one `CI result` job. A single Nix command checks formatting, lint, personal secrets, and Hatchi deployment safeguards, then builds the Nana and Hatchi NixOS systems. This gate does not build Darwin or Twin, run VM tests, deploy, activate, reboot, or contact either host.

`traitor verify srv-hatchi services-vm` remains a manual diagnostic. `traitor verify srv-hatchi policy` runs the same deployment safeguards checked by CI, including bootstrap validation and exact-node CLI behavior.

`traitor deploy <node>` builds locally by default. For deployment from a Mac without a Linux builder, add `--remote-build` to build on the target instead. Both `srv-nana` and `srv-hatchi` accept the flag.

```bash
traitor deploy srv-hatchi --remote-build
traitor deploy srv-hatchi --remote-build --dry-run
```

`--dry-run` builds the configuration and runs deploy-rs dry activation without switching the active system. The pinned deploy-rs can exit successfully after a failed dry-activation check; inspect its diagnostics rather than treating exit zero as a readiness gate. The flags can appear in any order after the node. Add `--skip-checks` to skip the deploy-rs pre-build checks. The deploy job passes it because CI already builds the flake checks on the runner.

## The deploy workflow

`deploy.yml` is separate from CI. It reacts to successful CI for a push to the current `main` revision, joins the tailnet as `tag:ci-deploy`, and deploys every host in its matrix with no approval step. The deploy builds on the target rather than on the runner, because a host's system closure is around 18 GiB and a stock runner has about 14 GB free. The cost is that CI no longer builds the artifact it deploys; the target builds from the same pinned flake, and the runner only evaluates it and orchestrates. The job allows 240 minutes, because the target compiles the closure itself when no cache holds it. The matrix lists the hosts that are ready to receive deploys, currently `srv-nana` and `srv-hatchi`. Add a host only when it carries its bootstrap files and answers the deployment account, since a host that cannot answer turns its job red. Prefix the job condition with `false &&` to stop automatic deploys. CI authenticates as the dedicated deployment account and builds from the runner's checkout, so no host-side synchronization step runs and the host needs no checkout of its own.

Before enabling deploys, configure one GitHub environment named `deploy` with required approval and these secrets:

- `TS_OAUTH_CLIENT_ID` and `TS_AUDIENCE` for a Tailscale federated identity restricted to this repository, environment, and `tag:ci-deploy`.
- `SSH_PRIVATE_KEY` for the configured deployment user.

Host keys are committed under `config/ssh/known_hosts/`, reviewed in pull requests, and installed by the workflow, with strict host-key checking still on. Adding a machine means its host configuration, its `deploy.nodes` entry, a matrix entry in `deploy.yml`, and its host key file under `config/ssh/known_hosts/`.

## The deploy account

The tailnet policy must permit `tag:ci-deploy` to reach the selected host on SSH. The host must resolve by its deployment name and authorize the deployment account's key. That account, named by `my.deploy.userName` in `modules/nixos/deploy.nix`, is the only account with passwordless sudo; the interactive user keeps password sudo. It is also a Nix trusted user on the host, which a remote build and an unsigned closure copy both need. Its only authorized key is `config/ssh/public-keys/ci-deploy.pub`, whose private half is in the GitHub environment secret and in 1Password for manual runs. The account and its sudo rule arrive in the same generation that first uses them, so a host's first activation must come from a credential it already has, such as root over SSH running `nixos-rebuild switch --flake "github:RestartDK/dotfiles#<host>"`. A `path:` flake pointing at a checkout owned by another user fails, because Nix refuses to read a Git checkout it does not own, and a root rebuild on a Linux host always evaluates as root. The workflow uses OpenSSH over Tailscale, not Tailscale SSH authentication. The Tailscale action removes its ephemeral runner when the job ends.

## Server install

Hatchi's physical profile puts EFI, NixOS, service state, and databases on the system SSD. The data HDD mounts at `/srv` for media and Nextcloud files. A missing data disk does not block NixOS or SSH, but it prevents the application stack from starting.

Hatchi has one physical NixOS configuration for installation and deployment. Its stable disk IDs and generated hardware facts are committed. Follow [the Hatchi installation procedure](../hosts/srv-hatchi/INSTALL.md) to run the guarded `nixos-anywhere` installation from a clean `main` checkout.

Hatchi's production configuration enables runtime 1Password secrets and declares its LAN as `192.168.200.0/24`. SSH remains allowed on `tailscale0` independently of the LAN rules. Before deployment, [provision the SOPS bootstrap files](../hosts/srv-hatchi/INSTALL.md#provision-secrets-before-deployment). A native pre-switch check rejects missing or undecryptable bootstrap files before changing running services. Credential formats and verification limits are documented in [the secret integration guide](../tests/srv-hatchi/onepassword.md).

## LAN runner

`deploy.yml` is meant to run on the self-hosted runner declared in `hosts/srv-hatchi/runner.nix`, labelled `lan-deploy`. Orchestrating a deploy from GitHub's cloud crosses a Tailscale relay, and that latency, not compilation, is what makes the current deploys take 45 to 85 minutes against a closure of 1818 paths. From the LAN the round trip is about 6 ms.

Two pieces are provisioned once on the host and are deliberately not in the store:

- `/var/lib/gh-runner/token` holds a fine-grained personal access token with `Administration: read and write` on `RestartDK/dotfiles`. The runner is ephemeral, so it re-registers for every job, which a one hour registration token cannot do.
- `/var/lib/nix-cache/secret` is the binary cache key, generated once with `nix-store --generate-binary-cache-key hatchi-cache-1 /var/lib/nix-cache/secret /var/lib/nix-cache/public`. Hatchi signs what it builds with it, and the public half belongs in the consumers' `extra-trusted-public-keys`.

Place the token before the first deploy. The runner's unit starts during activation, and without a token it exits non-zero, which deploy-rs reports as a failed activation and rolls back. The runner cannot be provisioned by the deploy that installs it.

Only the Deploy workflow targets `lan-deploy`, and it triggers on `workflow_run` after CI on `main`, so a pull request from a fork cannot reach the runner. The deploy key itself stays in the GitHub `deploy` environment behind its approval gate rather than on the runner.
