# Running 12iD on your own servers

This guide is for the team that installs and runs a 12iD release on its organisation's own servers. It
ships in the release bundle next to the scripts it names. Paths are relative to `/opt/12id`.

What you receive from 12iD:
- **the release bundle** `12id-bundle-X.Y.Z.tar.gz`: the compose files, the scripts, the runbooks and this guide;
- **`release-X.Y.Z.env`**: which images the release runs, each pinned by digest;
- **the images**, either through a **pull token** for 12iD's registry, or as a signed **offline kit** for a
  host without internet;
- **12iD's release public key**, separately from the kit, to check the kit.

## 1. What runs

One host runs everything, in Docker Compose stacks:

| Stack | Services | Reached from |
|---|---|---|
| `edge` | Caddy (TLS for every hostname, per-address limits), `indy-vdr-proxy` | the internet: 80, 443 |
| `mediator` | the DIDComm mediator (two replicas), its Postgres and Valkey | phones, through the edge |
| `agent` | agent-service (the organisations' issuing and verifying agents), endorser-service, the agents' Postgres | phones and the mediator, through the edge |
| `platform` | platform-api (the API your organisations' backends call) | backends, through the edge |
| `biometric` | biometric-service (the optional face check) | platform-api only |
| `console` | the operator console and the organisations' portal | staff browsers, through the edge |
| `monitoring` | Prometheus, Alertmanager, Grafana, exporters | an SSH tunnel only |
| `ledger-nodes` | four Indy validators (only with your own ledger network) | phones and agents: 9702, 9704, 9706, 9708 |

Six hostnames, each with a DNS record to the host:

| Setting | Serves | Note |
|---|---|---|
| `API_HOST` | platform-api | your organisations' backends |
| `CONSOLE_HOST` | the console | staff |
| `AGENT_HOST` | the agents' DIDComm endpoint | written into every wallet: choose it once |
| `MEDIATOR_HOST` | the mediator | written into every wallet: choose it once |
| `GENESIS_HOST` | the signed ledger genesis files | every app fetches from it: choose it once |
| `VDR_HOST` | ledger reads over HTTPS | for networks that block the ledger ports |

**Phones must reach** `MEDIATOR_HOST`, `AGENT_HOST`, `API_HOST` and `GENESIS_HOST` on 443, and the ledger's
client ports. The wallet lives on the phone, so "on premises" still means these are reachable from the
phones' networks (the internet, or the organisation's VPN for its own staff).

## 2. Sizing

Measured on 12iD's staging (`implement/19`, "Production sizing"):

| Peak load | Host |
|---|---|
| up to about 1 credential issued a second (3,600 an hour) | 4 vCPU, 8 GB RAM |
| up to about 3 a second (the agent's ceiling, about 200 a minute) | 8 vCPU, 16 GB RAM |
| more | not a bigger host: talk to 12iD |

Both rows include the four validators and monitoring. Disk: 100 GB to start; each exchange kept (90 days by
default) takes about 30 KB, and backups are kept 7 days on the host.

## 3. The host

- **Ubuntu 24.04 LTS** (another Linux with systemd works the same way), x86-64.
- **Docker Engine 28 or newer with the Compose plugin**, from Docker's own apt repository (or your mirror of
  it). Hold the version (`apt-mark hold docker-ce docker-ce-cli containerd.io docker-compose-plugin`) and
  upgrade it deliberately.
- `sops`, `age`, `minisign`, `openssl`, `curl`, `python3`. Ubuntu packages `age`, `minisign`; sops is a single
  binary from its GitHub releases. The offline kit carries sops, age and minisign and installs them.
- **A deploy user** (not root) in the `docker` group, with passwordless `sudo`: the scripts write the
  root-only secret files with it. `/opt/12id` belongs to this user.
- **Firewall:** allow 22 (or your management access), 80, 443, and with your own ledger network 9702, 9704,
  9706, 9708. Nothing else listens publicly: every internal service is published on 127.0.0.1 only. Docker's
  published ports bypass ufw, which is why the compose files never publish on 0.0.0.0 except the ledger's
  client ports.
- **Internal DNS:** the containers resolve the six hostnames through the host's DNS servers, not
  `/etc/hosts`. The agents fetch the genesis and reach the mediator through these names, so your DNS must
  answer them on the host too.
- Key-only SSH, automatic security updates, fail2ban: as your policy requires.

Unpack the bundle as the deploy user:
```sh
sudo install -d -o "$USER" /opt/12id && cd /opt/12id
tar xzf ~/12id-bundle-X.Y.Z.tar.gz          # infra/compose, infra/scripts, infra/systemd, infra/runbooks, …
cp ~/release-X.Y.Z.env infra/compose/release.env
```

## 4. Getting the images

**With internet: the pull token.** 12iD gives you a read-only token for its registry. On the host, as the
deploy user:
```sh
docker login ghcr.io -u <the account name 12iD gave you>      # the token at the password prompt
```

**Without internet: the offline kit.** Bring the kit to the host, then:
```sh
infra/scripts/offline-kit.sh verify /path/to/12id-offline-X.Y.Z --pub /path/to/12id-release.pub
infra/scripts/offline-kit.sh load /path/to/12id-offline-X.Y.Z
```
- `verify` checks 12iD's signature and every file. Do not use a kit that fails it.
- `load` installs sops, age and minisign if the host has none, starts a local registry on 127.0.0.1:5000
  (container `12id-registry`, restarted with Docker), puts every image into it, and rewrites
  `infra/compose/release.env` to pull from there. **The digests do not change**: what runs is exactly what
  12iD released.
- With a registry of your own (Harbor, Nexus): `load … --registry harbor.example/12id` pushes the images
  there instead, after `docker login` to it.

`infra/scripts/init.sh check` pulls one image by digest and tells you whether either way works.

## 5. DNS and certificates

Set `EDGE_TLS` in your environment file:

| `EDGE_TLS` | Certificates | Needs |
|---|---|---|
| `acme` (default) | Let's Encrypt, renewed automatically | public DNS for all six hostnames, port 80 reachable from the internet, `ACME_EMAIL` |
| `files` | your own | one certificate covering the six hostnames (SANs or a wildcard), full chain first, as `/opt/12id/tls/fullchain.pem` and `privkey.pem` (root-only directory; `EDGE_TLS_DIR` to move it) |

**A certificate from your own CA** (not a public one):
- set `EDGE_CA_FILE` to your CA's certificate (PEM) on the host: the services that call these hostnames
  themselves (the agents, monitoring, webhooks to your own backends, mail) trust it;
- **every app must trust it too**: its network security config names the CA (the SDK guide, "Genesis
  trust"). An app without it cannot connect at all;
- a renewed certificate: replace the two files, then
  `infra/scripts/deploy.sh edge up -d --force-recreate caddy`.

## 6. Keys and who holds them

| Key | Where | Who | Needed for |
|---|---|---|---|
| The offline age key | offline (a password manager, a safe) | your security officer | reading the secrets and every backup when the host is lost. Its public half (`age1…`) goes to `init.sh keys` |
| The host age key | `/opt/12id/secrets/age.key` | the host | deploying (decrypting the secrets files) |
| Trustee seeds (3), steward seeds (4) | offline media, each encrypted to its holder's age key | named people, ideally three different trustees | writing the endorser, adding or moving a validator. Never on the host |
| The genesis signing key | `/opt/12id/secrets/minisign.key`, and in the secrets files | the host | signing a new genesis version. **Its public key goes into every app** |
| A backup genesis signing key (advised) | offline | your security officer | signing at once if the host's key is lost, without an app update: give its public key to the app teams too |
| The registry pull token | `docker login` on the host | the host | pulling a release |

The secrets themselves (database passwords, tokens, store keys) are generated by `init.sh` into
`infra/env/<env>/secrets/*.sops.env`, encrypted to the host key and the offline key. Change one with
`infra/scripts/set-secret.sh`; never edit the files by hand. `infra/runbooks/key-rotation.md` has every key's
rotation.

## 7. First-time setup: `init.sh`

Everything below runs as the deploy user, in `/opt/12id`, with `ENV=<your environment name>` (default
`production`). Each step can be run again: it keeps what exists. `init.sh all` runs them in order and stops
where a person must act, printing the exact command that continues. Progress is in `/opt/12id/init.state`,
command output in `/opt/12id/init.log`.

1. **The environment file.** `ENV=prod infra/scripts/init.sh check` copies `infra/env/template.env` to
   `infra/env/prod.env` the first time. Fill it in (every setting is explained there), then run `check` again
   until it passes: tools, Docker, settings, certificate, DNS, ports, disk, and one image pull.
2. **Choose the ledger.**
   - **Your own network** (`--ledger new`): four validators on this host, created by a ceremony.
     `LEDGER_NETWORK_NAME`, `PUBLIC_IP` (what phones reach) and `LEDGER_SUBNET_PREFIX` (a private /24 your
     networks do not use) are written into the genesis, so check them first.
   - **A network you already have** (`--ledger existing --genesis pool_transactions_genesis`): its genesis
     and one of its trustee seeds. Networks with a transaction author agreement are not supported, nor
     networks where you only hold an endorser.
3. **Run it:**
   ```sh
   ENV=prod infra/scripts/init.sh all --ledger new --offline-recipient age1… [--backup-pub backup.pub]
   ```
   It stops, each time with the command that continues:
   - **secrets that need a person:** the console's mail server (`SMTP_URL`); optional: the alert mail password
     and 12iD's AWS keys for face checks. In a terminal it asks (hidden input);
   - **the custody holders' keys** (own network): each holder makes an age key on an offline machine; their
     public keys go into `/opt/12id/ceremony/recipients/default.txt`;
   - **after the ceremony:** copy each `/opt/12id/ceremony/out/custody/*.seed.age` to its holder's offline
     media, have them check it decrypts, then delete it from the host;
   - **the endorser:** a trustee holder pipes their seed in from offline media, never to disk:
     ```sh
     age -d -i /media/offline/trustee.key /media/offline/trustee-1.seed.age | ENV=prod infra/scripts/init.sh endorser
     ```
   Then run `init.sh all` again: it continues with the deploy, the timers and the checks.
4. **What it did, step by step:** `keys` (host age key, `.sops.yaml`, backup recipients, the genesis signing
   key and its public key in `GENESIS_SIGNING_PUBLIC_KEY`), `secrets`, `ledger` (ceremony, validators,
   genesis `v1` signed and published, the edge started), `postgres` (instances and one role per service),
   `endorser` (`ENDORSER_DID`), `deploy` (every stack of the release, then `check-inspect-clean.sh`: no
   secret is visible in `docker inspect`), `timers` (nightly backup, ledger write probe every 15 minutes),
   `verify` (health, the public endpoints, a ledger write).
5. **Keep** `infra/env/<env>.env`, `infra/env/<env>/` (secrets, the ledger's public files, the genesis public
   keys) and `/opt/12id/.sops.yaml` in your own version control or backup: they are this environment. The
   secrets files are encrypted; the offline key opens them.

## 8. The first operator and the first organisation

```sh
ENV=prod infra/scripts/init.sh operator --email you@example.com --name 'Your Name'
```
It prints a one-time password once. Sign in at `https://<CONSOLE_HOST>`: the console makes you enrol an
authenticator app first. Further operators are invited from **Operators**.

An organisation (a tenant) is created from **Tenants** in the console. When it is ready, its Overview has
"Create organization", which invites its first owner by mail; the owner invites the rest and creates the API
key their backend uses. `infra/runbooks/console.md` has the details.

## 9. The SDK in your apps

- `com.12id:holder-sdk-android` **0.3.0 or newer**, from `https://maven.12id.com`. Without internet for
  builds, the offline kit's `maven/` holds 12iD's artifacts and `DEPENDENCIES.md`, the public libraries they
  need, for your Maven proxy.
- Every app passes **your genesis public key** (and the backup one) as `genesisPublicKeys`: `GENESIS_SIGNING_PUBLIC_KEY`
  in your environment file, or `infra/env/<env>/genesis-signing.pub`. With a private CA, the app also trusts
  that CA. Both are in the SDK guide, "Genesis trust".
- `apiBaseUrl` is `https://<API_HOST>`.

## 10. The face check

The optional face check (liveness and match) uses **AWS Rekognition Face Liveness** today: each organisation
brings its own AWS account, and the platform reaches it through 12iD's AWS principal (`BIOMETRIC_AWS_*`
secrets, `infra/runbooks/biometric-service.md`). It needs outbound HTTPS to AWS. A vendor that runs on your
premises is planned (12iD theme D). Leave `BIOMETRIC_ENABLE_MOCK=false`: the mock passes anyone and is for
tests only.

## 11. Backups

- **Nightly** (02:30 UTC, `12id-backup.timer`): every database, the validators' data and the published
  genesis, encrypted before they touch disk to the host key and your offline key, into
  `/opt/12id/backups/`. The host keeps 7 days.
- **Off site:** a machine elsewhere pulls `/opt/12id/backups` over SSH with a read-only key
  (`infra/scripts/backup-pull.sh`, `infra/runbooks/backup-restore.md` "Off-site copies") and keeps 30 daily
  and 12 monthly copies. A compromised host cannot delete them.
- **Test a restore** with the offline key alone, as `backup-restore.md` describes, before you rely on it. The
  whole-host rebuild is `infra/runbooks/disaster-recovery.md` (`infra/scripts/dr-rebuild.sh`).

## 12. Upgrades

1. Read the release notes. With the offline kit, `verify` and `load` the new kit first.
2. Unpack the new bundle over `/opt/12id` (it never contains `infra/env/<env>/`, so your settings and secrets
   stay) and copy its `release-X.Y.Z.env` to `infra/compose/release.env` (with the kit, `load` wrote it).
   Keep the previous bundle and `release.env` for a rollback.
3. `infra/scripts/init.sh check`, then for each stack in the order of `init.sh` (`mediator`, `agent`,
   `biometric`, `platform`, `console`, `monitoring`, `edge`):
   ```sh
   ENV=prod infra/scripts/deploy.sh <stack> pull && ENV=prod infra/scripts/deploy.sh <stack>
   ```
   then `infra/scripts/pg-roles.sh all` and `ENV=prod infra/scripts/init.sh verify`.
4. **Rollback:** database migrations stay compatible with the previous release, so the previous bundle and its
   `release.env`, deployed the same way, bring the previous version back. From 0.11.0 on a `release.env` names
   the third-party images too, so roll back with both files of the same release, never one without the other.

## 13. Monitoring and alerts

- Prometheus, Alertmanager and Grafana listen on 127.0.0.1 only:
  `ssh -L 3300:127.0.0.1:3300 -L 9093:127.0.0.1:9093 <host>`, then Grafana at `http://127.0.0.1:3300` (user
  `admin`, password `GRAFANA_ADMIN_PASSWORD` in `monitoring.sops.env`).
- **Alert mail:** `ALERT_SMTP_*` and `ALERT_EMAIL_TO` in the environment file; the mail account's password is
  the monitoring secret `GMAIL_APP_PASSWORD` (the name is historical; any SMTP provider works). Without it,
  alerts show in the console only.
- The console's **System health** page (operators) shows the readiness checks and the firing alerts.
- The ledger write probe proves the validators still agree; reachable ports alone do not.

## 14. Runbooks in the bundle

| Runbook | For |
|---|---|
| `backup-restore.md` | backups, the off-site pull, restoring one database |
| `disaster-recovery.md` | losing a key, a database, the mediator's queue, the whole host |
| `key-rotation.md` | every secret and key, one procedure each |
| `genesis-rotation.md` | a new genesis version, moving a validator to its own host |
| `ledger-ceremony.md` | what the ceremony creates (`init.sh ledger new` runs it) |
| `postgres-roles.md` | the per-service database roles |
| `console.md` | operators, organisations, sign-in rules |
| `biometric-service.md` | the face check provider |
| `platform-api.md` | the API service |
| `production-bringup.md` | how 12iD brings up its own production with `init.sh` |
