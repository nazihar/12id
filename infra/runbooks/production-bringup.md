# Runbook: production bring-up (and any new environment)

**Plan:** `implement/18-phase-9-production.md` W5. **Built in W2 (2026-09-29):** per-environment config,
file secrets, the image-only release bundle, pulled backups, and our own ledger. Staging runs the same
bundle (`ENV=staging`) and is where every step below was rehearsed; the ledger steps have their own
runbook, [ledger-ceremony.md](ledger-ceremony.md).

## How a deploy is put together
`infra/scripts/deploy.sh <stack>` (with `ENV=production`) runs `docker compose` on:

| Input | Where | Contents |
|---|---|---|
| The release bundle | `infra/compose/` | One set of compose files for every environment, the Caddyfile, monitoring config. No `build:` anywhere |
| `release.env` | `infra/compose/release.env` | `REGISTRY`, `VERSION` and one `*_DIGEST` per image, written by `infra/scripts/release.sh` (CI later). Deploys pull `REGISTRY/12id-<name>:VERSION@DIGEST` |
| The environment file | `infra/env/production.env` | Hostnames, ledger settings, mail sender. Not secret; `template.env` explains every key |
| The environment's overlays | `infra/env/production/compose.<stack>.yml`, `caddy/*.caddy` | Nothing in production; staging adds its von-network tools and extra sites |
| Secrets | `infra/env/production/secrets/<stack>.sops.env` | Encrypted to the VM's age key and the offline key (`.sops.yaml`) |

Secrets reach containers as files (review M11): `deploy.sh` decrypts each key a compose file mounts into
`/opt/12id/run-secrets/<stack>/<KEY>` (directory root 0700, file root:12000 0440), and the containers
read `NAME_FILE` from `/run/secrets`. No secret is in `docker inspect`. After a reboot Docker restarts
every container from those files, unattended. Check with `infra/scripts/check-inspect-clean.sh`.

A deploy never builds. Rollback = redeploy with the previous `release.env`.

## 1. The VM (owner + operator)
- Ubuntu LTS, key-only SSH (`/etc/ssh/sshd_config.d/00-12id-hardening.conf` as on staging), ufw
  allowing 22, 80, 443 and the Indy client ports 9702/9704/9706/9708 only, fail2ban,
  unattended-upgrades, Docker from Docker's apt repository with the version pinned.
- Passwordless `sudo` for the deploy user (`deploy.sh` writes `/opt/12id/run-secrets` with it).
- `/etc/default/12id` containing `ENV=production` (the systemd units read it).
- Its own age key: `age-keygen -o /opt/12id/secrets/age.key` (root 0600). Put its public key and the
  **production offline key** (generated offline by the owner, public half only) into `.sops.yaml` and
  `infra/env/production/backup-recipients.txt`.
- A GHCR token with **read:packages only**, used as `docker login ghcr.io` on the VM. Never a token that can
  write or administer anything.

## 2. Freeze and generate
- DNS A records for every hostname in `production.env` to the VM.
- Fill in `production.env`: `ACME_EMAIL`, `PUBLIC_IP`, the mail settings. `GENESIS_SHA256` and
  `ENDORSER_DID` come from step 3.
- The production minisign key pair (primary + backup) for the genesis; the public keys go to W3 (SDK).
- Every secret fresh, never copied from staging:
  `ENV=production infra/scripts/set-secret.sh <stack> <KEY> --generate` for tokens, passwords, store keys
  and seeds; `set-secret.sh <stack> <KEY>` (hidden prompt) for provider values (SMTP, AWS).
  `BIOMETRIC_MASTER_KEY` is 32 random bytes in base64 (`openssl rand -base64 32`, entered at the prompt).
  Shared values must match: `PLATFORM_AGENT_TOKEN` (agent, platform), `MEDIATOR_ADMIN_TOKEN` (mediator,
  platform), `CONSOLE_TOKEN` (console, platform); `MEDIATOR_WEBHOOK_URL` is
  `http://platform-api:3500/internal/mediator/<MEDIATOR_WEBHOOK_SECRET>`.

## 3. Ledger
[ledger-ceremony.md](ledger-ceremony.md): ceremony, validators, genesis v1 signed, endorser bootstrap
with a trustee key from offline media, write probe.

## 4. Deploy every stack from one release
```sh
export ENV=production
infra/scripts/pg-roles.sh all                # roles and databases (after the Postgres containers exist)
for s in edge mediator agent biometric platform console monitoring; do infra/scripts/deploy.sh $s pull; done
infra/scripts/deploy.sh mediator && infra/scripts/check-mediator-tables.sh --after-start
infra/scripts/deploy.sh agent
infra/scripts/deploy.sh biometric
infra/scripts/deploy.sh platform
infra/scripts/deploy.sh console
infra/scripts/deploy.sh monitoring
infra/scripts/deploy.sh edge
infra/scripts/check-inspect-clean.sh
```
Postgres needs its roles before the services connect: on a fresh VM start the two Postgres containers
first (`deploy.sh mediator up -d postgres`, `deploy.sh agent up -d agent-postgres`), run `pg-roles.sh all`,
then the full list. Operator accounts: `deploy.sh console run --rm console-tools npx auth create-admin …`
([console.md](console.md)).

## 5. Backups
- Timers: `sudo cp infra/systemd/12id-{backup,ledger-probe}.{service,timer} /etc/systemd/system/`,
  `daemon-reload`, `enable --now` both timers.
- The backup machine: [backup-restore.md](backup-restore.md) "Off-site copies".

## 6. Smoke and gate
The W5 smokes and probes of `18-phase-9-production.md`, then the go-live gate.

## Updating later
Copy the next bundle's `infra/` (never over `infra/env/production/secrets/`), then
`deploy.sh <stack> pull` and `deploy.sh <stack>` for each stack. Migrations stay backward compatible
for one release, so a rollback is the previous `release.env` and the same two commands.
