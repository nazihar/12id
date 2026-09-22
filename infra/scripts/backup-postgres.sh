#!/usr/bin/env bash
# Nightly encrypted Postgres backups for staging (W9).
#
# Every database in the mediator stack's Postgres, plus roles, is dumped and encrypted with
# the VM's age key before it touches disk:
#   drizzle         mediator DIDComm storage (connections, mediation records)
#   message_pickup  queued messages for holders
#   mediator        mediator Askar KMS store
#
# VM-local by decision (owner, 2026-09-13): losing the VM loses these backups too, and the
# age key that decrypts them. Accepted for a resettable staging ledger; not a production pattern.
#
# Restore: infra/runbooks/backup-restore.md
set -euo pipefail

ROOT="${ROOT:-/opt/12id}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
DEPLOY="$ROOT/infra/scripts/deploy.sh"
DATABASES=(drizzle message_pickup mediator)

recipient="$(age-keygen -y "$ROOT/secrets/age.key")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$BACKUP_DIR/$stamp"

umask 077
mkdir -p "$dest"

for db in "${DATABASES[@]}"; do
  "$DEPLOY" mediator exec -T postgres pg_dump -U postgres --format=custom "$db" \
    | age -r "$recipient" > "$dest/$db.dump.age"
  # age output of an empty pipe is still a few hundred bytes; a real dump is far larger.
  if [ "$(stat -c %s "$dest/$db.dump.age")" -lt 1024 ]; then
    echo "backup of $db looks empty" >&2
    exit 1
  fi
done

"$DEPLOY" mediator exec -T postgres pg_dumpall -U postgres --globals-only \
  | age -r "$recipient" > "$dest/globals.sql.age"

# Phase 2 agent stack: its own Postgres instance.
#   agent_root        agent-service root Askar store (tenant wallets: keys, connections, credentials)
#   agent_service     tenants, catalogue, outbox
#   endorser          platform endorser Askar store (the endorser private key, encrypted by Askar);
#                     on the mediator instance until Phase 7 H3
#   endorser_service  tenant bindings, endorsement audit
#   platform_api      Phase 3: tenants, API keys, wallets, mirror tables, webhook queue
#   console           Phase 4: console accounts, organizations, sessions, 2FA secrets (Better Auth)
#   biometric         Phase 6: tenant vendor config and reference images (AES-GCM, master key in
#                     biometric.sops.env, not in the dump), sessions, scores and decisions
# compose.agent.yml interpolates secrets from two files, so deploy.sh needs EXTRA_SECRETS here.
# Since Phase 7 H3 every service has its own role, so the roles (globals) are dumped here too.
if [ -f "$ROOT/infra/staging/compose.agent.yml" ] && EXTRA_SECRETS=ledger "$DEPLOY" agent ps --status running agent-postgres | grep -q agent-postgres; then
  for db in agent_root agent_service endorser endorser_service platform_api console biometric; do
    EXTRA_SECRETS=ledger "$DEPLOY" agent exec -T agent-postgres pg_dump -U postgres --format=custom "$db" \
      | age -r "$recipient" > "$dest/agent-$db.dump.age"
    if [ "$(stat -c %s "$dest/agent-$db.dump.age")" -lt 1024 ]; then
      echo "backup of agent $db looks empty" >&2
      exit 1
    fi
  done
  EXTRA_SECRETS=ledger "$DEPLOY" agent exec -T agent-postgres pg_dumpall -U postgres --globals-only \
    | age -r "$recipient" > "$dest/agent-globals.sql.age"
fi

(cd "$dest" && sha256sum -- *.age > SHA256SUMS)

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf -- {} +

echo "backup $stamp: $(du -sh "$dest" | cut -f1) in $dest"
