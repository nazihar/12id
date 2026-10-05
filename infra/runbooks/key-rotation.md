# Runbook: key rotation (every environment)

**Phase 9 W4 (2026-10-01).** One section per secret: what it protects, who reads it, how to rotate it,
what users notice, and how to check. Every rotation below is meant to be rehearsed on staging first; the
"Rehearsed" line of each section records it (evidence in `implement/19-phase-9-production-findings.md` W4).

**Rules for every rotation**
- Run on the VM as `ubuntu`, with `ENV=staging|production` (default staging). Values never appear on
  screen, in shell history or in a process argument: `set-secret.sh` generates or prompts, and the
  rotation scripts pass keys on stdin.
- **Take a backup first** when the secret protects stored data (Askar stores, biometric, console 2FA):
  `sudo systemctl start 12id-backup.service`. A backup can only be read with the keys that were current
  when it was taken, and those stay readable in the sops files' git history and with the offline key.
- After the change, redeploy every stack that reads the secret (the table says which), then run the
  checks in its section and `infra/scripts/check-inspect-clean.sh` (must stay at 0).
- Commit the changed `infra/env/<env>/secrets/*.sops.env` (and env files) from the VM's tree to the repo.

## Inventory

| Secret (sops file) | Protects | Read by (redeploy) | Method | Users notice |
|---|---|---|---|---|
| `PLATFORM_AGENT_TOKEN` (agent, platform) | platform-api → agent-service internal API | agent, platform | [Shared token](#shared-tokens) | API calls that reach the agent fail for the seconds between the two deploys |
| `AGENT_ENDORSER_TOKEN` (agent) | agent-service → endorser-service | agent | [Shared token](#shared-tokens) | ledger writes wait for the agent stack's restart |
| `CONSOLE_TOKEN` (platform, console) | console → platform-api console scope | platform, console | [Shared token](#shared-tokens) | console pages error until both are up |
| `MEDIATOR_ADMIN_TOKEN` (mediator, platform) | platform-api → mediator admin routes (invitations, sweep) | mediator, platform | [Shared token](#shared-tokens) | new wallet invitations fail between the deploys; the mediator restart pauses polling (~1 min) |
| `BIOMETRIC_INTERNAL_TOKEN` (biometric) | platform-api → biometric-service | biometric, platform | [Shared token](#shared-tokens) (one file, two stacks) | biometric calls fail between the deploys |
| `MEDIATOR_WEBHOOK_SECRET` (platform) + `MEDIATOR_WEBHOOK_URL` (mediator) | the mediator's wake webhook path | platform, mediator | [Shared token](#shared-tokens) with `--also` | wake webhooks fired between the deploys are lost (the poll still delivers) |
| `PLATFORM_ADMIN_TOKEN` (platform) | operator admin API (`/admin/*`, VM-local) | platform | [Single token](#single-tokens) | none |
| `*_DB_PASSWORD`, `PLATFORM_RO_PASSWORD`, `MONITORING_DB_PASSWORD` | Postgres roles (Phase 7 H3) | the role's stack (+ monitoring) | [Database password](#database-passwords) | none if done in order |
| `POSTGRES_PASSWORD` (mediator), `AGENT_POSTGRES_PASSWORD` (agent) | the instances' superusers | nothing at runtime (`pg-roles.sh`, backups use the local socket) | [Superuser password](#superuser-passwords) | none |
| `BETTER_AUTH_SECRET` (console) | console sessions and the encrypted TOTP secrets | console | [Console auth secret](#console-auth-secret) | everyone signs in again; 2FA enrollments are kept |
| `BIOMETRIC_MASTER_KEY` (biometric) | per-tenant data keys (vendor config, reference images) | biometric | [Biometric master key](#biometric-master-key) | biometric checks pause for about a minute |
| `AGENT_ASKAR_STORE_KEY` (agent) | every tenant's wallet: keys, DIDs, connections, cred-def private keys | agent | [Askar store key](#askar-store-keys) | DIDComm and the agent API down for about a minute |
| `ENDORSER_ASKAR_STORE_KEY` (ledger) | the endorser DID's private key | agent (endorser-service), ledger tools | [Askar store key](#askar-store-keys) | ledger writes wait |
| `MEDIATOR_ASKAR_STORE_KEY` (mediator) | the mediator's DIDComm keys | mediator | [Askar store key](#askar-store-keys) | every wallet's polls fail for about a minute |
| The endorser DID's key (in its Askar store) | endorsement of tenants' ledger writes | agent, ledger tools | [Endorser DID](#endorser-did) | none for tenants; a few minutes of refused writes during the switch |
| `MINISIGN_SECRET_KEY_B64` (genesis) + `/opt/12id/secrets/minisign.key` | the genesis signature | genesis publishing | [Genesis signing key](#genesis-signing-key) | SDKs must trust the new public key (M15) |
| `/opt/12id/secrets/age.key` | every sops file and the VM-side backups | deploy, backups | [Age key](#age-key) | none |
| `GMAIL_APP_PASSWORD` / SMTP (`SMTP_URL`), `GRAFANA_ADMIN_PASSWORD` | outgoing mail, Grafana | monitoring, console | [Single token](#single-tokens) (set the provider's new value with the prompt) | none |
| `BIOMETRIC_AWS_*` | 12id's AWS principal | biometric | [Single token](#single-tokens) (create the new access key in AWS first, delete the old one after) | none |
| TLS certificates | the edge | Caddy | [TLS](#tls) | none |

## Shared tokens
Tokens that two stacks must hold with the same value. `set-secret.sh` writes one generated value into
every listed stack's file at once:
```sh
infra/scripts/set-secret.sh agent,platform PLATFORM_AGENT_TOKEN --generate
infra/scripts/deploy.sh agent && infra/scripts/deploy.sh platform
```
- `CONSOLE_TOKEN`: `set-secret.sh platform,console CONSOLE_TOKEN --generate`, deploy platform then console.
- `MEDIATOR_ADMIN_TOKEN`: `set-secret.sh mediator,platform …`, deploy mediator then platform.
- `AGENT_ENDORSER_TOKEN`: both ends are in the agent stack: `set-secret.sh agent AGENT_ENDORSER_TOKEN --generate`, deploy agent.
- `BIOMETRIC_INTERNAL_TOKEN`: one file read by two stacks: `set-secret.sh biometric … --generate`, deploy biometric then platform.
- The mediator webhook: the URL embeds the secret path, so both are written together:
  ```sh
  infra/scripts/set-secret.sh platform MEDIATOR_WEBHOOK_SECRET --generate \
    --also 'mediator:MEDIATOR_WEBHOOK_URL=http://platform-api:3500/internal/mediator/{}'
  infra/scripts/deploy.sh platform && infra/scripts/deploy.sh mediator
  ```
Deploy the receiving side first, then the caller: the interruption is the time between the two deploys.
There is no dual-token window (owner: keep it simple). **Check:** `smoke:platform-credo` (agent, mediator
and the wake path), `e2e:staging` (console), `smoke:biometric-credo` (biometric).

Rehearsed on staging 2026-10-04: all seven tokens (PLATFORM_AGENT, CONSOLE, MEDIATOR_ADMIN, AGENT_ENDORSER, BIOMETRIC_INTERNAL, the mediator webhook secret + URL, PLATFORM_ADMIN) in one pass; five stacks redeployed in 74 s; `smoke:platform-credo`, `smoke:biometric-credo` 18/18, `e2e:staging` 3/3; `check-inspect-clean.sh` 0.

## Single tokens
One reader: `set-secret.sh <stack> <KEY> --generate` (or the hidden prompt for a provider's value), then
deploy that stack. `PLATFORM_ADMIN_TOKEN` is used by operators through an SSH tunnel; tell them.

## Database passwords
`infra/scripts/pg-roles.sh` sets each role's password from the sops files, so the order is: new value,
roles, then the readers. Open connections keep working (Postgres checks the password at connect), so
nothing is interrupted.
```sh
infra/scripts/set-secret.sh agent AGENT_SERVICE_DB_PASSWORD --generate
infra/scripts/pg-roles.sh agent          # ALTER ROLE … PASSWORD from the new value
infra/scripts/deploy.sh agent
```
`MONITORING_DB_PASSWORD` is read by the exporters (`deploy.sh monitoring`); `PLATFORM_RO_PASSWORD` by
platform-api. **Check:** the stack's services healthy, `psql` as the role with the new password.

Rehearsed on staging 2026-10-04: `AGENT_SERVICE_DB_PASSWORD`; agent-service healthy, 0 authentication failures.

## Superuser passwords
Postgres reads `POSTGRES_PASSWORD_FILE` only when it creates a volume, so the running instance keeps the
old password until it is changed inside. Nothing logs in as the superuser over the network.
```sh
infra/scripts/set-secret.sh mediator POSTGRES_PASSWORD --generate
export SOPS_AGE_KEY_FILE=/opt/12id/secrets/age.key
pw="$(sops -d --extract '["POSTGRES_PASSWORD"]' infra/env/$ENV/secrets/mediator.sops.env)"
# printf is a shell builtin and the SQL goes on stdin: the value is never a process argument.
printf "alter role postgres password '%s';\n" "$pw" | docker exec -i mediator-postgres-1 psql -U postgres -q
unset pw
```
The same for `AGENT_POSTGRES_PASSWORD` in the agent stack's Postgres container.

## Console auth secret
`BETTER_AUTH_SECRET` signs sessions **and encrypts every TOTP secret**, so replacing it outright would
break every 2FA enrollment (the console restore drill found this). Better Auth 1.7's versioned secrets keep
them (`console/src/server/auth-secrets.server.ts`): `CONSOLE_AUTH_SECRET_VERSION` in the env file is the
current secret's version; `BETTER_AUTH_SECRET_PREVIOUS` decrypts the old values until they are moved.
1. Keep the old value as the previous one, generate the new one, and bump the version (0 → 1 the first
   time, then 1 → 2, …):
   ```sh
   infra/scripts/set-secret.sh console BETTER_AUTH_SECRET_PREVIOUS --from BETTER_AUTH_SECRET
   infra/scripts/set-secret.sh console BETTER_AUTH_SECRET --generate
   sed -i 's/^CONSOLE_AUTH_SECRET_VERSION=.*/CONSOLE_AUTH_SECRET_VERSION=1/' infra/env/$ENV.env   # add the line if missing
   infra/scripts/deploy.sh console
   ```
   Every session ends (sessions are signed with the current secret); users sign in again with their
   existing TOTP.
2. Move every TOTP secret to the new version (idempotent, one transaction):
   `infra/scripts/deploy.sh console run --rm console-reencrypt` → `{"reencrypted":N,"alreadyCurrent":0,…}`.
3. Retire the old secret: `set-secret.sh console BETTER_AUTH_SECRET_PREVIOUS --unset`, `deploy.sh console`.

**Check:** `e2e:staging` 3/3 (sign-in with TOTP for an account enrolled before the rotation).
Rehearsed on staging 2026-10-04: version 0 → 1; `e2e:staging` 3/3 with the previous secret in place (6 TOTP enrollments still bare-hex), `console-reencrypt` → `{"reencrypted":6}` (a re-run: `alreadyCurrent: 6`), previous secret removed, `e2e:staging` 3/3 again.

## Biometric master key
The master key wraps one data key per tenant; rotation re-wraps them (`services/biometric-service/src/
rotate-master-key.ts`, one transaction). Stored vendor configurations and images are not re-encrypted.
```sh
sudo systemctl start 12id-backup.service
infra/scripts/rotate-biometric-key.sh
```
It generates `BIOMETRIC_MASTER_KEY_NEXT`, stops biometric-service, re-wraps with the next key on stdin,
then promotes it, removes `_NEXT` and redeploys. On a failed re-wrap nothing changed and the service
restarts on the current key. **Check:** `smoke:biometric-credo` 18/18 (it reads the tenant's stored
mock configuration).
Rehearsed on staging 2026-10-04: 3 tenant keys re-wrapped; `smoke:biometric-credo` 18/18 on the new key.

## Askar store keys
One `rekey` re-encrypts the whole store, so the agent's root store covers every tenant profile in it
(`services/credo-base/src/askar-rekey.ts`; Askar's default argon2i key derivation, as Credo and the
mediator use). The store's users are stopped meanwhile.
```sh
sudo systemctl start 12id-backup.service
infra/scripts/rotate-askar-key.sh agent       # or endorser, mediator
```
`rotate-askar-key.sh` generates `<KEY>_NEXT`, stops the users (agent-service; endorser-service; both
mediator replicas), runs the one-shot with the next key on stdin (it proves the next key opens the store
and the current one no longer does), promotes the key and redeploys. A failure leaves the store as it was.
- **The mediator's store** is opened with our Askar (the services image), not the mediator's own: the
  first rotation runs on a scratch restore of the `mediator` dump before staging (W4).
- **The endorser's key** is also read by the ledger stack's `bootstrap-endorser`; it reads the same sops
  key, so nothing else changes.
- **Backups:** a dump taken before the rotation opens only with the old key, which stays in the sops
  history and with the offline key.

**Check:** agent: `smoke:platform-credo`; endorser: a schema publish (`smoke:platform-credo` publishes);
mediator: `smoke:credo` and `smoke:platform-credo` (existing wallets keep polling).
Rehearsed on staging 2026-10-04: first on scratch restores of that night's dumps (`mediator` 4,160 items, `agent_root` 6,242, `endorser`: all `rekeyed`, the mediator's store opened with our Askar), then live: agent (26 s, `smoke:platform-credo`), endorser (`bootstrap-endorser` → `existing`, schema publish), mediator (both replicas back in 50 s, existing wallets' polls 0 errors, `smoke:platform-credo`).

## Endorser DID
A new endorser identity: a new DID and key in the same store, registered with role ENDORSER, then the
old one is retired. Tenants are unaffected: their DIDs are role-less authors, and any endorser can endorse
their writes. Use it when the endorser key may be compromised (a store-key rotation does not change the
DID's key).
1. Create and register the new endorser. Production: a trustee signs (`runbooks/ledger-ceremony.md`);
   staging: von-network's trustee (its seed is public, review L16), hex-encoded:
   ```sh
   age -d -i <offline media>/<trustee>.key trustee-1.seed.age \
     | infra/scripts/deploy.sh ledger run --rm -T -e ENDORSER_REGISTRAR=trustee bootstrap-endorser src/bootstrap-endorser.ts --rotate
   # staging: printf '%s\n' "$(printf 000000000000000000000000Trustee1 | xxd -p -c 64)" | … same command
   ```
   It prints `result: rotated`, the new `did` and the `previous` one.
2. Set `ENDORSER_DID=<new did>` in `infra/env/$ENV.env` and `deploy.sh agent` (agent-service and
   endorser-service; endorser-service refuses to start if the store lacks the DID).
3. Check: an existing tenant publishes a schema and a cred def (`smoke:platform-credo`), and a new tenant
   onboards (`platform-bootstrap.ts`).
4. Retire the old DID (the trustee resets its role; its past endorsements stay valid):
   `… | deploy.sh ledger run --rm -T -e ENDORSER_REGISTRAR=trustee bootstrap-endorser src/bootstrap-endorser.ts --demote <old did>`.

Rehearsed on staging 2026-10-04 with von-network's trustee: `--rotate` wrote `NiDNzVvC7DfuJ5s3itjp5Q` (role ENDORSER), `ENDORSER_DID` switched, an existing tenant's schema (txn 1957) carries the new endorser, a new tenant onboarded, `--demote` reset `9WnSruRkr6b3V7XX9zPjka` to role null. Found: an empty `LEDGER_PROBE_SEED` file made the run fail after the rotation (fixed in `bootstrap-endorser.ts`).

## Genesis signing key
The minisign key signs each published genesis version. **The SDK will compile in 12id's public keys,
primary and backup (M15)**, so a rotation is: sign with the backup key at once, ship an SDK release that
trusts a new backup, then retire the old primary.
1. New key on the VM: `minisign -G -p new.pub -s /opt/12id/secrets/minisign.key.new` (no password, like
   the current one); store it as `MINISIGN_SECRET_KEY_B64` (`set-secret.sh genesis …` from the file).
2. Publish the next genesis version from the current pool ledger with the new key
   (`snapshot-genesis.sh`, `genesis-rotation.md`), and set `GENESIS_VERSION` and
   `GENESIS_SIGNING_PUBLIC_KEY` in the env file; `deploy.sh platform` (`/v1/ledger` points SDKs at it).
3. Replace `infra/env/$ENV/genesis-signing.pub`; keep the old public key until every SDK in use trusts
   the new one.

Rehearsed on staging 2026-10-04: new key `B84C710C4BA2C31C`, genesis `v2` (same content and sha256 as v1) signed and verified, `GENESIS_VERSION=v2` + the new public key deployed (agent, platform, edge, monitoring); `/v1/ledger` advertises v2. Found: publishing under `umask 077` left `v2/` mode 0700 and the non-root vdr-proxy crash-looped (`snapshot-genesis.sh` now sets 0755/0444); `set-secret.sh` dropped a piped value without a final newline (fixed). The old key is `/opt/12id/secrets/minisign.key.prev-w4` until it goes offline.

## Age key
The VM's age key decrypts every sops file and the VM-side backups. Every file is also encrypted to the
environment's offline key, so the old VM key can be destroyed once the files are re-keyed.
1. `age-keygen -o /opt/12id/secrets/age.key.new` (root 0600); note its public key.
2. In `.sops.yaml`, replace the environment's VM recipient with the new public key (the offline one stays);
   copy it to the VM's tree.
3. Re-key every file with the old key still in place:
   `for f in infra/env/$ENV/secrets/*.sops.env; do sops updatekeys -y "$f"; done`.
4. `sudo mv /opt/12id/secrets/age.key.new /opt/12id/secrets/age.key`; then `deploy.sh` any stack (it
   decrypts with the new key) and run a backup (`backup-postgres.sh` derives the VM recipient from the key).
5. Older backups and the git history stay readable with the offline key, **but check that first:** decrypt one file
   of every backup still kept with the offline key alone. Backups older than the offline recipient (staging: before
   2026-09-29) open only with the old VM key; re-encrypt them to the current recipients
   (`age -d -i old | age -R recipients`, then rewrite `SHA256SUMS` as `backup-postgres.sh` does) before you destroy it.
   Then destroy the old VM key (`shred -u`).

Rehearsed on staging 2026-10-04: new VM recipient `age13wc3…`, all eight files re-keyed and decrypting with it, the old key refused; a deploy and a backup on the new key (the new backup does not open with the old key). The old key is `/opt/12id/secrets/age.key.prev-w4` until the owner destroys it.

## TLS
Caddy obtains and renews certificates by itself (`CertificateExpiringSoon` alerts at 14 days). If a
private key may be compromised: stop the edge, delete Caddy's data volume entry for that host
(`/data/caddy/certificates/…`), revoke at the CA (`caddy` has no revoke command; use the ACME account
with `certbot revoke --cert-path`), start the edge so it issues a new certificate. Not rehearsed.

## Owner-held credentials (not on the VM)
The GHCR read token, the trustee seeds and the offline age key are rotated by the owner: the GHCR token in
GitHub's settings (then `docker login` on the VM), trustee seeds through a NYM key rotation signed by
another trustee (`ledger-ceremony.md`), and the offline age key by adding the new recipient to
`.sops.yaml`/`backup-recipients.txt`, `sops updatekeys`, and keeping the old one for the backups it opens.
