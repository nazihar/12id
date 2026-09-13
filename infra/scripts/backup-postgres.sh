#!/usr/bin/env bash
# Nightly encrypted Postgres backups for staging (W9).
#
# Every database in the mediator stack's Postgres, plus roles, is dumped and encrypted with
# the VM's age key before it touches disk:
#   drizzle         mediator DIDComm storage (connections, mediation records)
#   message_pickup  queued messages for holders
#   mediator        mediator Askar KMS store
#   endorser        platform endorser Askar store (the endorser private key, encrypted by Askar)
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
DATABASES=(drizzle message_pickup mediator endorser)

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

(cd "$dest" && sha256sum -- *.age > SHA256SUMS)

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf -- {} +

echo "backup $stamp: $(du -sh "$dest" | cut -f1) in $dest"
