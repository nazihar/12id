# Runbook: Postgres backup and restore (staging)

## What is backed up
`infra/scripts/backup-postgres.sh`, run nightly at 02:30 UTC by `12id-backup.timer`, dumps every database in the mediator stack's Postgres:

| Database | Contents | Loss means |
|---|---|---|
| `drizzle` | Mediator DIDComm storage: connections, mediation records | Every holder must re-register for mediation |
| `message_pickup` | Queued, still-encrypted messages for holders | Undelivered messages are lost |
| `mediator` | Mediator Askar KMS store | Mediator keys lost: routing keys in every holder's DID documents stop working |
| `endorser` | Platform endorser Askar store | The endorser DID becomes unusable; a new endorser NYM is needed |
| globals | Postgres roles | Recreated by the image; kept for completeness |

Phase 2 adds the agent stack's own Postgres (`agent-postgres`), dumped to `agent-<db>.dump.age` when that stack is running:

| Database | Contents | Loss means |
|---|---|---|
| `agent_root` | agent-service root Askar store: every tenant's keys, DIDs, connections, cred def private keys, exchange records | Tenants cannot issue against their published cred defs (private keys gone); all holder connections dead |
| `agent_service` | tenants, catalogue (both id forms), outbox | Platform loses the mapping from catalogue ids to ledger objects |
| `endorser_service` | tenant→DID bindings, endorsement audit | The endorser refuses every tenant until bindings are restored; audit trail lost |

Restore of `agent_root` needs `AGENT_ASKAR_STORE_KEY` from `secrets/agent.sops.env`.

Each dump is `pg_dump --format=custom`, piped straight into `age` with the VM's age recipient, so no plaintext dump touches disk. Output goes to `/opt/12id/backups/<UTC timestamp>/` with a `SHA256SUMS` file. Directories older than 7 days are deleted.

**The Askar stores are encrypted twice:** by Askar with their store keys (in `infra/staging/secrets/*.sops.env`), and by age. A restore needs the age key and the matching sops secrets.

**Scope decision (2026-09-13):** backups are VM-local. Losing the VM loses the backups and the age key that decrypts them. Accepted for staging; production needs an offsite copy and a separately held key.

## Install / check the timer
```sh
sudo cp /opt/12id/infra/staging/systemd/12id-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now 12id-backup.timer
systemctl list-timers 12id-backup.timer
sudo systemctl start 12id-backup.service && journalctl -u 12id-backup.service -n 20 --no-pager
```

## Restore drill (scratch Postgres, no impact on the running stack)
Run on the VM as `ubuntu`. This is the drill required by the Phase 1 plan (W9).

1. **Pick a backup and verify its checksums:**
   ```sh
   B=/opt/12id/backups/$(ls /opt/12id/backups | tail -1)
   (cd "$B" && sha256sum -c SHA256SUMS)
   ```
2. **Start a scratch Postgres** on an isolated network, with the same major version (15) as the stack:
   ```sh
   docker network create 12id-restore-drill
   docker run -d --name restore-pg --network 12id-restore-drill -e POSTGRES_PASSWORD=drill postgres:15-alpine
   until docker exec restore-pg pg_isready -U postgres; do sleep 2; done
   ```
3. **Decrypt each dump into the scratch container and restore it:**
   ```sh
   for db in drizzle message_pickup mediator endorser; do
     age -d -i /opt/12id/secrets/age.key "$B/$db.dump.age" \
       | docker exec -i restore-pg pg_restore -U postgres --create --dbname=postgres
   done
   docker exec restore-pg psql -U postgres -tAc "select datname from pg_database where not datistemplate order by 1"
   ```
4. **Check the content:**
   ```sh
   docker exec restore-pg psql -U postgres -d drizzle -tAc 'select count(*) from "StorageVersion"'
   docker exec restore-pg psql -U postgres -d message_pickup -tAc "select state, count(*) from queued_message group by 1"
   ```
5. **Prove the restored stores open with the real keys.** Give the scratch database a name on the network the tools already use, then run the endorser bootstrap against it. It must report `result: existing` with the known DID `did:indy:twelveid:staging:9WnSruRkr6b3V7XX9zPjka`:
   ```sh
   docker network connect --alias restore-pg 12id-mediator restore-pg
   cd /opt/12id/infra/staging
   EXTRA_SECRETS=mediator ../scripts/deploy.sh ledger run --rm \
     -e POSTGRES_HOST=restore-pg:5432 -e POSTGRES_PASSWORD=drill \
     bootstrap-endorser
   ```
6. **Clean up:**
   ```sh
   docker network disconnect 12id-mediator restore-pg
   docker rm -f restore-pg && docker network rm 12id-restore-drill
   ```
7. **Record the drill** (date, backup used, results) in the Phase 1 findings.

## Console restore drill (`agent-console.dump.age`)
Proves the console backup restores **and that accounts can still sign in**: password hashes live in the
dump, TOTP secrets are encrypted with `BETTER_AUTH_SECRET` (in `console.sops.env`, not in the dump).
Last run: 2026-09-15, backup `20260915T023447Z`, passed.

1. Checksum as above, then a scratch Postgres on its own network and restore:
   ```sh
   docker network create 12id-console-restore-drill
   docker run -d --name console-restore-pg --network 12id-console-restore-drill -e POSTGRES_PASSWORD=drill postgres:15-alpine
   age -d -i /opt/12id/secrets/age.key "$B/agent-console.dump.age" \
     | docker exec -i console-restore-pg pg_restore -U postgres --create --dbname=postgres
   docker exec console-restore-pg psql -U postgres -d console -tAc 'select email, role, two_factor_enabled from "user"'
   ```
2. A throwaway console on the restored copy, on `127.0.0.1:3690`, with the real `BETTER_AUTH_SECRET` from
   sops written to an env file in `/dev/shm` (deleted right after `docker run`), `DATABASE_URL` pointing at
   `console-restore-pg`, `BETTER_AUTH_URL=https://12id.naziharitsolution.com`, and dummy
   `PLATFORM_API_URL`/`CONSOLE_TOKEN`/`SMTP_URL` (no route to platform-api, no mail).
3. Sign in with a known account through `curl` on the VM (`Origin: https://12id.naziharitsolution.com`):
   `POST /api/auth/sign-in/email` → 200 `twoFactorRedirect`; `POST /api/auth/two-factor/verify-totp` with a
   wrong code → 401, with a current code → 200. Confirm the session row appeared in the **restored**
   database (`select … from session where created_at > now() - interval '15 minutes'`). Send the code on
   stdin, never on the command line.
4. Clean up: `docker rm -f console-restore-app console-restore-pg && docker network rm 12id-console-restore-drill`.

A restore under a different `BETTER_AUTH_SECRET` keeps passwords working but every TOTP enrollment fails
to decrypt: keep the secret with the backups' key material.

## Real restore (replacing the running databases)
1. Stop the consumers: `deploy.sh mediator stop mediator-1 mediator-2`.
2. Drop and recreate the affected databases in `mediator-postgres-1`, then `pg_restore` as in the drill, into the stack's own Postgres.
3. Start the replicas and run `check-mediator-tables.sh --after-start`, then `smoke:credo`.
