# Runbook: disaster recovery (every environment)

**Phase 9 W4 (2026-10-01).** What to do when something is lost, what it costs users, and the drill that
proves each path. Backups: [backup-restore.md](backup-restore.md) (nightly 02:30 UTC, two age recipients,
pulled off-site). Key changes: [key-rotation.md](key-rotation.md).

**Targets with nightly backups:** RPO 24 h (the last backup). RTO: one database about 30 min, the whole
VM about 2–4 h (measured in the drills below; GHCR's download speed from the VM dominates, see W2).

**Before any restore:**
- Stop what writes to the affected database, so nothing new lands while you work.
- Verify the backup: `(cd "$B" && sha256sum -c SHA256SUMS)`.
- Askar dumps open only with the store key that was current when they were taken (`key-rotation.md`):
  take the key from the sops file at that date (git history) if it has been rotated since.

## Scenarios

| Lost | Impact | Recovery | What users and tenants see |
|---|---|---|---|
| [The endorser key](#the-endorser-key) | No new tenant onboarding, schema or cred-def publication | Restore the `endorser` store, or rotate to a new endorser DID | Ledger writes fail until done; issuance and proofs unaffected |
| [A wallet database (`agent_root`)](#the-agent-wallet-database) | Tenants cannot issue or verify; cred-def private keys | Restore `agent_root` + `agent_service` from the same backup | Exchanges after the backup are lost: re-offer them |
| [The mediator queue (`message_pickup`)](#the-mediator-queue) | Queued, undelivered messages gone | Restore or start empty | Offers and proof requests queued at the time never arrive: re-offer |
| [The mediator's connections (`drizzle`) or keys (`mediator`)](#the-mediators-connections-or-keys) | Every wallet's mediation | Restore both from the same backup | If unrecoverable: **every phone must `reset()` and be re-issued** |
| [platform-api / console databases](#platform-api-and-console) | API keys, wallets map, webhooks, console accounts | Restore | Changes after the backup are gone (new keys, wallets) |
| [A validator](#a-validator) | One of four: nothing (f = 1); two: ledger writes stop | Restart, or restore its volume | Nothing for one; writes fail for two |
| [The whole VM](#the-whole-vm) | Everything | Rebuild from the bundle, the off-site backups and the offline key | Outage for the rebuild; changes after the last backup are lost |

## The endorser key
The endorser's Ed25519 key lives only in the `endorser` Askar store (agent-postgres). Tenant keys are
not affected.
1. **Restore** `agent-endorser.dump.age` (see [Restoring one database](#restoring-one-database)), with
   `ENDORSER_ASKAR_STORE_KEY` as of that backup. `deploy.sh ledger run --rm bootstrap-endorser` must
   report `result: existing` with the configured `ENDORSER_DID`.
2. **If no backup opens** (or the key may be compromised): rotate to a new endorser DID
   ([key-rotation.md, Endorser DID](key-rotation.md#endorser-did)). A trustee key from offline custody is
   needed in production. Existing tenants keep working: their DIDs are role-less and need any endorser.

## The agent wallet database
`agent_root` holds every tenant's keys, DIDs, connections, cred-def private keys and Credo exchange
records; `agent_service` maps them (tenants, catalogue, outbox). **Restore both from the same backup.**
- Exchanges that moved after the backup roll back in Credo. The holder's side has already moved on, so
  those exchanges are stuck: agent-service's reconciliation abandons waiting records after
  `RECONCILE_TTL_MS` (24 h) and the webhook reports it; tenants re-offer.
- Connections and tenant DIDs created after the backup are lost; those holders reconnect through a new
  invitation.
- The outbox resumes from the restored `outbox_cursor`; platform-api may receive events it already has
  (idempotent by id).

## The mediator queue
`message_pickup.queued_message` holds still-encrypted messages waiting for a poll. Restoring an old copy
re-delivers messages already picked up (holders ignore duplicates by thread) and cannot return what
arrived after the backup. Usually start it empty instead:
1. `deploy.sh mediator stop mediator-1 mediator-2`.
2. Restore `message_pickup` or create it empty (`pg-roles.sh mediator`, then start a replica: the mediator
   creates the table).
3. Start the replicas. Exchanges whose offer or request was lost wait until reconciliation abandons them;
   re-offer.

## The mediator's connections or keys
`drizzle` holds every wallet's mediation (connection, keylist); `mediator` holds the mediator's DIDComm
keys, which are routing keys inside every holder's DID documents. **They only work together: restore both
from the same backup**, with `MEDIATOR_ASKAR_STORE_KEY` as of that backup.
- Wallets created after the backup lose their mediation: the mediator no longer knows their connection
  and refuses their polls. Whether the SDK recovers on its own (as it does for a spent invitation, trap 31)
  or needs `reset()` is not verified yet; until a drill shows otherwise, treat them like the case below.
- **If neither can be restored**, every wallet is cut off: the platform must ask each customer to call
  `reset()` and re-issue, which is why these two are in every backup and pulled off-site.

## platform-api and console
`agent-platform_api.dump.age` and `agent-console.dump.age`: restore as below. The console's TOTP secrets
need `BETTER_AUTH_SECRET` (and `BETTER_AUTH_SECRET_PREVIOUS` during a rotation) as of the backup.

## A validator
- **Hung or stopped:** production validators restart themselves (`compose.ledger-nodes.yml` healthcheck:
  three failed client-port checks end the process). Check `deploy.sh ledger-nodes ps` and the write probe.
- **Volume lost:** restore `ledger-nodeN.tar.gz.age` into the volume (it holds the node's keys and its
  ledger), start it, let it catch up from the others (`validator-info`). Without a backup the node's keys
  are gone: a new node needs a NODE transaction by its steward and a genesis rotation
  ([genesis-rotation.md](genesis-rotation.md)).
- **Two or more lost:** writes stop (`LedgerWriteProbeFailing`); reads continue while one answers.

## Restoring one database
1. Stop its writers (above).
2. Verify the backup and decrypt with the VM key (or the offline key on another machine):
   ```sh
   B=/opt/12id/backups/<stamp>; (cd "$B" && sha256sum -c SHA256SUMS)
   ```
3. Replace the database in its own instance, as the superuser, through the local socket:
   ```sh
   docker exec -i agent-agent-postgres-1 psql -U postgres -c 'drop database "agent_root" with (force)'
   age -d -i /opt/12id/secrets/age.key "$B/agent-agent_root.dump.age" \
     | docker exec -i agent-agent-postgres-1 pg_restore -U postgres --create --dbname=postgres
   ```
4. `infra/scripts/pg-roles.sh agent` (or `mediator`): the restored objects belong to the service role
   again (Askar finds its tables through the role's schema, so this step is not optional).
5. Start the stack (`deploy.sh agent`) and run its smoke.

## The whole VM
Inputs, and nothing from the lost VM: the repo (release bundle + `infra/env/<env>*`), the backup
machine's newest copy, the environment's **offline age key**, a **GHCR read token** (owner-held), and the
trustee seeds only if the ledger cannot be restored. Steps 2, 4 and 5 are scripted in
`infra/scripts/dr-rebuild.sh` (`prep`, `restore`, `deploy`, `check`); the 2026-10-04 rehearsal ran it.
1. **A new VM** as in [production-bringup.md](production-bringup.md) §1, with its own new age key.
2. **Secrets:** on a machine holding the offline key, re-key the environment's sops files to the new VM
   key (`.sops.yaml`, `sops updatekeys` with `SOPS_AGE_KEY_FILE` = the offline key), commit, copy the tree.
   The secrets are unchanged; consider rotating them afterwards.
3. **Ledger (production):** restore the four validator volumes from `ledger-node{1..4}.tar.gz.age`, publish
   the same genesis from `genesis.tar.gz.age` to `/opt/12id/genesis`. Same IPs → nothing changes for
   clients. A new public IP: the genesis carries the old client IP, so publish a rotated genesis
   ([genesis-rotation.md](genesis-rotation.md)) before the SDKs can reach the ledger.
4. **Databases:** start the two Postgres containers, `pg-roles.sh all`, restore every dump (as above,
   `pg_restore --create`), then `pg-roles.sh all` again (ownership, and the monitoring grants on tables that
   only exist after the restore).
5. **Stacks:** the deploy order of production-bringup.md §4, then `check-inspect-clean.sh`.
6. **DNS:** point the hostnames at the new VM (if the address changed).
7. **Smokes:** the W5 list; then re-enable the backup timer and the backup machine's pull key.

## Drills
| Drill | Where | Last run |
|---|---|---|
| Every database into a scratch Postgres | staging (`19-…` W4 D2) | 2026-10-04: 10 dumps in 12 s, 11 key counts equal to live |
| Restore with the offline key only | another machine (backup-restore.md) | 2026-09-29 (W2) |
| Mediator queue lost, live | staging, load-test tenant's rows only | not run: the rows cannot be isolated without a cross-instance join, and the outcome is the table above |
| Whole VM, rehearsal | WSL distro on the dev PC, from staging's pulled backups and the offline key | 2026-10-04: about 8 min of machine time (pull 16 s, restore 36 s, deploy 331 s); every service healthy, counts equal to the backup, edge probes and API calls through the restored wallets and mediator |
| Whole VM, the gating drill | a scratch VM, from production's pulled backups | after W5 |
