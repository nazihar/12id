# Runbook: production bring-up (and any new environment)

**Plan:** `implement/18-phase-9-production.md` W5. **Since implement/28 (Q2, platform 0.11.0) the bring-up is
`infra/scripts/init.sh`**, the same tool a self-hosting customer runs, so every production bring-up also
tests the self-host path. The full walk-through is [`../self-host.md`](../self-host.md) §7; this runbook keeps
what is specific to 12iD's own production. The manual steps this replaces (about 30) are in this file's git
history before 2026-10-25.

## How a deploy is put together
`infra/scripts/deploy.sh <stack>` (with `ENV=production`) runs `docker compose` on:

| Input | Where | Contents |
|---|---|---|
| The release bundle | `infra/compose/` | One set of compose files for every environment, the Caddyfile, monitoring config, `third-party.images`, `secrets.list`. No `build:` anywhere |
| `release.env` | `infra/compose/release.env` | `REGISTRY`, `VERSION`, one `*_DIGEST` per 12iD image and one `*_IMAGE` per third-party image, written by `infra/scripts/release.sh` in CI. Deploys pull `REGISTRY/12id-<name>:VERSION@DIGEST` |
| The environment file | `infra/env/production.env` | Hostnames, TLS mode, ledger settings, mail sender. Not secret; `template.env` explains every key |
| The environment's overlays | `infra/env/production/compose.<stack>.yml`, `caddy/*.caddy` | Nothing in production; staging adds its von-network tools and extra sites |
| Secrets | `infra/env/production/secrets/<stack>.sops.env` | Encrypted to the VM's age key and the offline key (`.sops.yaml`) |

Secrets reach containers as files (review M11): `deploy.sh` decrypts each key a compose file mounts into
`/opt/12id/run-secrets/<stack>/<KEY>` (directory root 0700, file root:12000 0440), and the containers read
`NAME_FILE` from `/run/secrets`. No secret is in `docker inspect` (`infra/scripts/check-inspect-clean.sh`).
After a reboot Docker restarts every container from those files, unattended. A deploy never builds.

## 1. The VM (owner + operator)
As [`../self-host.md`](../self-host.md) §3, plus:
- key-only SSH (`/etc/ssh/sshd_config.d/00-12id-hardening.conf` as on staging), ufw (22, 80, 443, 9702/9704/
  9706/9708), fail2ban, unattended-upgrades; Docker from Docker's apt repository, version held;
- the deploy user `ubuntu` with passwordless sudo, owning `/opt/12id`;
- a GHCR token with **read:packages only** (`docker login ghcr.io`). Never a token that can write anything;
- the **production offline age key**, generated offline by the owner; only its public half (`age1…`) reaches
  the VM, as `init.sh keys --offline-recipient`.

## 2. Freeze and generate
- DNS for every hostname in `production.env` (`*.12id.com`), `EDGE_TLS=acme`, `ACME_EMAIL`, `PUBLIC_IP`, the
  mail settings. Frozen before the first real wallet: the mediator and agent hostnames, the genesis URL, the
  namespace `twelveid`, the endorser DID, the genesis signing keys.
- **Genesis signing keys:** `init.sh keys` generates the primary on the VM. The owner generates the **backup**
  offline (`minisign -G`) and passes its public file as `--backup-pub`. Both public keys go into the SDK's
  `PRODUCTION_GENESIS_PUBLIC_KEYS` (M15) with the next SDK release.
- Trustee custody: who holds which trustee seed (`ledger-ceremony.md` "Before").

## 3. Run it
```sh
cd /opt/12id
ENV=production infra/scripts/init.sh all --ledger new --offline-recipient age1… --backup-pub backup.pub
```
Then follow its stops (secrets with a person, custody recipients, moving the custody files off the VM, the
trustee's seed for the endorser), each with the command that continues. Finally:
```sh
ENV=production infra/scripts/init.sh operator --email <owner> --name '<name>'
```

## 4. After `init.sh`
- **Commit the environment** from the VM to the repo: `infra/env/production.env`, `infra/env/production/`
  (secrets, `ledger/`, `genesis-signing.pub`, `backup-recipients.txt`) and the production rule of
  `/opt/12id/.sops.yaml` (merge it into the repo's `.sops.yaml`).
- **The backup machine:** [backup-restore.md](backup-restore.md) "Off-site copies", then a restore drill from
  the pulled copy with the offline key.
- **Alert mail:** confirm the test alert arrives.

## 5. Smoke and gate
The W5 smokes and probes of `18-phase-9-production.md`, then the go-live gate.

## Updating later
[`../self-host.md`](../self-host.md) §12: the next bundle and `release.env`, then `deploy.sh <stack> pull` and
`deploy.sh <stack>` for each stack. Rollback is the previous bundle **and** its `release.env`.
