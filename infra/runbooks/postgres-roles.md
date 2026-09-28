# Runbook: per-service Postgres roles, per-hop tokens and the endorser network (Phase 7 H2 + H3)

Review findings H2 and H3 (`implement/17-phase-7.md`):
- Every service connected to Postgres as the superuser `postgres`.
- The endorser's Askar key store sat on the mediator's instance.
- One internal token plus two shared networks let platform-api call endorser-service.

After this change:
- **Each service has its own non-superuser login role** and owns only its own databases. `PUBLIC` has no `CONNECT` on any managed database. The script is `infra/scripts/pg-roles.sh`, which is idempotent.
- **The endorser store is on `agent-postgres`**, owned by `endorser_service`. The mediator's instance holds only the mediator's own databases. We decided against a dedicated instance for now: the roles plus Askar's own encryption are the two layers. Revisit when production moves to an HSM or needs instance-level isolation.
- **Tokens are per hop.**
  - platform-api presents `PLATFORM_AGENT_TOKEN` to agent-service.
  - agent-service presents `AGENT_ENDORSER_TOKEN` to endorser-service. It lives only in `agent.sops.env`.
- **endorser-service is only on `12id-endorser`,** together with agent-service and agent-postgres. platform-api, the console and the mediator cannot resolve it.

## Who connects to what

**`agent-postgres`** (networks `12id-agent` and `12id-endorser`)

| Database | Owner role | Other access |
|---|---|---|
| `agent_root` (Askar, tenant wallets), `agent_service` | `agent_service` | — |
| `endorser` (Askar, endorser DID key), `endorser_service` | `endorser_service` | — |
| `platform_api` | `platform_api` | `monitoring_ro`: SELECT on `exchange_gates`, `exchange_gate_events` |
| `console` | `console` | — |
| `biometric` | `biometric` | — |

**Mediator `postgres`** (network `12id-mediator`)

| Database | Owner role | Other access |
|---|---|---|
| `drizzle` | `mediator` | `platform_ro`: SELECT on `DidcommConnection(id, out_of_band_id, thread_id)`; `monitoring_ro`: SELECT on `DidcommMediation` |
| `message_pickup` | `mediator` | `monitoring_ro`: SELECT on `queued_message`, `live_session` |
| `mediator` (Askar KMS) | `mediator` | — |

`monitoring_ro` also has `pg_monitor`, which gives the exporters' default metrics. The name cannot start with `pg_`, because Postgres reserves that prefix.

The superuser passwords, `AGENT_POSTGRES_PASSWORD` and `POSTGRES_PASSWORD`, remain in four places only:
- the Postgres containers
- the `agent-provision` job's admin account (used only if `agent_root` is missing)
- `pg-roles.sh`
- the backup script

## Secrets to add (on the VM; the VM's `*.sops.env` files are the source of truth, trap 45)

**Shortcut:** `infra/scripts/phase7-secrets.sh` does everything in this section, and is idempotent:
- sets every key below that is missing
- copies `CONSOLE_TOKEN` into `platform.sops.env` if it is missing
- checks that the shared values match

The manual steps it runs follow.

Every value is `[A-Za-z0-9]`, 24 characters or more. `pg-roles.sh` refuses anything else, because it interpolates the values into SQL. Generate a value and set it without it ever appearing on screen:

```sh
cd /opt/12id
gen() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-40; }
gen | infra/scripts/set-secret.sh agent AGENT_SERVICE_DB_PASSWORD
gen | infra/scripts/set-secret.sh agent ENDORSER_DB_PASSWORD
gen | infra/scripts/set-secret.sh agent AGENT_ENDORSER_TOKEN
gen | infra/scripts/set-secret.sh platform PLATFORM_DB_PASSWORD
gen | infra/scripts/set-secret.sh console CONSOLE_DB_PASSWORD
gen | infra/scripts/set-secret.sh biometric BIOMETRIC_DB_PASSWORD
gen | infra/scripts/set-secret.sh mediator MEDIATOR_DB_PASSWORD
gen | infra/scripts/set-secret.sh monitoring MONITORING_DB_PASSWORD
# The same value in two files (like MEDIATOR_ADMIN_TOKEN and CONSOLE_TOKEN):
t=$(gen); printf '%s\n' "$t" | infra/scripts/set-secret.sh agent PLATFORM_AGENT_TOKEN
printf '%s\n' "$t" | infra/scripts/set-secret.sh platform PLATFORM_AGENT_TOKEN; unset t
```

- `PLATFORM_RO_PASSWORD` (`platform.sops.env`) already exists. Its value must be `[A-Za-z0-9]`; if not, regenerate it the same way.
- Once the rollout below has passed, remove `AGENT_INTERNAL_TOKEN` from `agent.sops.env`.
- Commit the updated `*.sops.env` files from the VM so the repository matches.

## One-time rollout on staging

Before you start:
- Take a fresh backup with the **old** backup script: `sudo systemctl start 12id-backup.service`.
- Then sync the new tree to the VM, excluding `infra/staging/secrets/` because the VM's files are newer.

Syncing the compose files changes no running container. Steps 1–3 must happen in the same session: from step 1 on, the new backup script dumps `endorser` from agent-postgres and fails if that database is still empty.

Steps 1–2 change no running service. Every service still connects as `postgres` until its stack is redeployed.

1. **Roles and ownership on both instances.** This creates `agent-postgres`'s empty `endorser` database:
   ```sh
   infra/scripts/pg-roles.sh all
   ```
2. **Rehearse the verification queries** below as each new role. Every one should already behave as described.
3. **Move the endorser store.** Onboarding and ledger publishing pause for a few minutes; everything else keeps running.
   ```sh
   cd /opt/12id/infra/staging
   docker stop agent-endorser-service-1
   docker exec mediator-postgres-1 pg_dump -U postgres --format=custom endorser \
     | docker exec -i agent-agent-postgres-1 pg_restore -U postgres --no-owner --no-acl --exit-on-error -d endorser
   ../scripts/pg-roles.sh agent        # endorser_service takes the restored tables
   docker exec agent-agent-postgres-1 psql -U postgres -d endorser -tAc 'select count(*) from postgres.items'
   docker exec mediator-postgres-1 psql -U postgres -d endorser -tAc 'select count(*) from postgres.items'   # must match (Askar schema: trap 49)
   ```
4. **Redeploy in dependency order.** Each Askar store's schema is renamed at its stack's cutover, with that store's consumers stopped (trap 49).
   - Askar keeps its tables in schema `"$user"`, and existing stores were created as `postgres`.
   - Under the new role they would look empty, and Askar would fail to open them or provision an empty store.
   - The old containers still connect as `postgres`, so rename only right before the new ones start.
   ```sh
   docker stop mediator-mediator-1-1 mediator-mediator-2-1
   infra/scripts/pg-roles.sh askar-schema-mediator             # schema postgres -> mediator
   infra/scripts/deploy.sh mediator up -d                      # migrate job + both replicas as `mediator`
   infra/scripts/check-mediator-tables.sh --after-start
   # The replica log must say "Reusing existing out of band invitation" (same keys), not a new one.
   docker stop agent-agent-service-1                           # endorser-service is already stopped (step 3)
   infra/scripts/pg-roles.sh askar-schema-agent                # agent_root -> agent_service, endorser -> endorser_service
   EXTRA_SECRETS=ledger infra/scripts/deploy.sh agent up -d --remove-orphans
   infra/scripts/deploy.sh biometric up -d
   EXTRA_SECRETS=biometric infra/scripts/deploy.sh platform up -d
   infra/scripts/deploy.sh console up -d
   infra/scripts/deploy.sh monitoring up -d --force-recreate postgres-exporter postgres-exporter-drizzle postgres-exporter-biometric
   ```
   - endorser-service opens the moved store. It refuses to start unless the store holds `ENDORSER_DID`, so a healthy container proves the store moved.
   - If platform-api still reads `CONSOLE_TOKEN` from the console file on the VM (trap 45), add `console` to its `EXTRA_SECRETS`.
5. **Run the verification below.** Then run the restore drill (`backup-restore.md`) from the next nightly backup.
6. **After 7 days of normal operation, drop the old copy:**
   ```sh
   docker exec mediator-postgres-1 psql -U postgres -c 'DROP DATABASE endorser'
   ```
   Until then, `pg-roles.sh mediator` keeps it closed to everyone except the superuser. It is the rollback path: point the old compose file back at it.
   The nightly backup never included this copy. Before dropping it, dump it with `age` and prove that the dump restores, as staging did (below).

A fresh environment uses the same order: start `postgres` / `agent-postgres` alone, run `pg-roles.sh`, then bring each stack up. The provision jobs find their databases already created and owned by the right role, and run their migrations as that role.

**Run `pg-roles.sh` again after any restore** (`--no-owner` restores leave objects owned by `postgres`) and after changing any of the passwords above.

## Verification

```sh
cd /opt/12id/infra/staging
# H2: platform-api and the mediator cannot resolve the endorser; old token refused.
EXTRA_SECRETS=biometric ../scripts/deploy.sh platform exec -T platform-api node -e \
  'fetch("http://endorser-service:3420/healthz").then(()=>console.log("REACHABLE"),e=>console.log(e.cause?.code))'   # ENOTFOUND
../scripts/deploy.sh mediator exec -T mediator-1 node -e \
  'fetch("http://endorser-service:3420/healthz").then(()=>console.log("REACHABLE"),e=>console.log(e.cause?.code))'   # ENOTFOUND
../scripts/deploy.sh mediator exec -T mediator-1 getent hosts agent-postgres || echo "agent-postgres: not resolvable"

# H3: no service role is a superuser; cross-database connections are refused.
docker exec agent-agent-postgres-1 psql -U postgres -tAc "select rolname, rolsuper from pg_roles where rolcanlogin order by 1"
docker exec mediator-postgres-1 psql -U postgres -tAc "select rolname, rolsuper from pg_roles where rolcanlogin order by 1"
# Privileges per role (socket login inside the container is `trust` in the official image, so no
# password is needed; CONNECT is still enforced). Only the owner's own databases may connect.
for r in agent_service endorser_service platform_api console biometric monitoring_ro; do
  for d in agent_root agent_service endorser endorser_service platform_api console biometric; do
    printf '%-17s %-17s ' "$r" "$d"
    docker exec agent-agent-postgres-1 psql -U "$r" -d "$d" -tAc 'select 1' 2>&1 | tail -1
  done
done
for r in mediator platform_ro monitoring_ro; do
  for d in drizzle message_pickup mediator endorser; do
    printf '%-17s %-17s ' "$r" "$d"
    docker exec mediator-postgres-1 psql -U "$r" -d "$d" -tAc 'select 1' 2>&1 | tail -1
  done
done
```

The expected result for each role:

| Role | Databases where it gets `1` | Everywhere else |
|---|---|---|
| `agent_service` | `agent_root`, `agent_service` | `permission denied` |
| `endorser_service` | `endorser`, `endorser_service` | `permission denied` |
| `platform_api` | `platform_api` | `permission denied` |
| `console` | `console` | `permission denied` |
| `biometric` | `biometric` | `permission denied` |
| `monitoring_ro` | `platform_api` on agent-postgres; `drizzle` and `message_pickup` on the mediator instance | `permission denied` |
| `mediator` | `drizzle`, `message_pickup`, `mediator` | `permission denied` for `endorser` |
| `platform_ro` | `drizzle` | `permission denied` |

Container names follow Compose's `<project>-<service>-1`. Check them with `docker ps` if a command above does not match.

Then run the smokes:
- `smoke:platform-credo`
- tenant onboarding plus a schema and cred-def publish from the console (both go through the endorser)
- `smoke:biometric-credo` (mock)
- console `e2e:staging`

In Prometheus, `pg_up` must be 1 for the three exporters, and the biometric, mediation and queue series must still update.

## Rollout record

Staging, 2026-09-22 (backup before: `20260922T053321Z`; first backup after: `20260922T055950Z`).
- **Secrets:** set on the VM by `phase7-secrets.sh`. It also restored `CONSOLE_TOKEN` in `platform.sops.env` (trap 45).
- **Roles and the endorser move:** item counts matched (config 3, profiles 1, items 4, items_tags 6).
- **Askar schema rename:** found during the rollout (trap 49).
  - The mediator reused its invitation.
  - agent-provision reported the existing store (12 profiles).
  - endorser-service loaded `9WnSruRkr6b3V7XX9zPjka`.
- **H2:** platform-api, console, biometric-service and mediator-1 all get `ENOTFOUND` for `endorser-service`; only agent-service reaches it. The endorser refuses the platform→agent token (401).
- **H3:** the role/database matrix is exactly the table above, and no service role is a superuser.
- **Monitoring:** three exporters `pg_up=1`, `pg_exporter_last_scrape_error=0`, and the custom series still populated.
- **Smokes:**
  - `smoke:biometric-credo` 18/18.
  - `smoke:platform-credo` PASSED with a new tenant, `Phase 7 H2-H3 smoke 2026-09-22`. Its NYM, schema and cred def went through the moved endorser.
  - Console `e2e:staging` 3/3.
- **Restore drill:** the endorser store from `agent-endorser.dump.age` reported `result: existing` with the known DID.
- **Leftovers, done 2026-09-28 (Phase 9 W1):**
  - **The old `endorser` database on the mediator instance is dropped.**
    - It went one day before the planned date, at the owner's request to close W1. Rolling back to it would have lost six days of endorser writes anyway.
    - First it was dumped to `/opt/12id/backups/mediator-endorser-predrop-20260928.dump.age`. The file is encrypted to the VM's age key, and the rotation (which prunes only dated directories) keeps it.
    - The dump was restored into a scratch database: 4 tables, identical row counts (`items` 4, `items_tags` 6, `profiles` 1, `config` 3). The scratch database was then dropped.
    - The store's tables sat in schema `postgres`, the old store user (trap 49).
    - No session was open on it when it was dropped. The instance now holds `drizzle`, `mediator`, `message_pickup` and `postgres`.
  - `AGENT_INTERNAL_TOKEN` is removed from `agent.sops.env` (`set-secret.sh agent AGENT_INTERNAL_TOKEN --unset`). The key-name diff against the saved copy shows only that key gone.
  - The VM's `*.sops.env` files match the repo.
