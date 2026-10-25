#!/usr/bin/env bash
# Nightly encrypted backups (W9; off-site since Phase 9 W2, review M13).
#
# Every database of both Postgres instances, their roles, and (production) the validators' data
# volumes are dumped and encrypted before they touch disk, to two kinds of age recipient:
#   - the VM's own key (/opt/12id/secrets/age.key), for a restore on this VM;
#   - the offline key(s) in infra/env/<env>/backup-recipients.txt, whose private half never touches
#     a server: backups decrypt even if the VM and its key are both lost.
#
# A backup machine at another site pulls /opt/12id/backups nightly over SSH with a read-only key
# (infra/scripts/backup-pull.sh, runbooks/backup-restore.md). A backup is written to
# .incomplete-<stamp> and renamed when complete, so a pull never copies half of one. The VM keeps
# KEEP_DAYS (7) days; the backup machine keeps 30 daily and 12 monthly.
#
#   mediator postgres: drizzle (mediator DIDComm storage), message_pickup (queued messages),
#                      mediator (mediator Askar KMS store), globals (roles)
#   agent-postgres:    agent_root (tenant wallets), agent_service, endorser (the endorser key, encrypted
#                      by Askar), endorser_service, platform_api, console, biometric (reference images
#                      encrypted with the master key, which is in SOPS, not here), globals
#   ledger (production, compose.ledger-nodes.yml): each validator's /var/lib/indy (ledger + node keys)
#   genesis: the published genesis versions (/opt/12id/genesis)
#
# Restore: infra/runbooks/backup-restore.md
set -euo pipefail

ENV="${ENV:-staging}"
ROOT="${ROOT:-/opt/12id}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
GENESIS_DIR="${GENESIS_DIR:-$ROOT/genesis}"
DEPLOY="$ROOT/infra/scripts/deploy.sh"
OFFLINE_RECIPIENTS="$ROOT/infra/env/$ENV/backup-recipients.txt"
# Only for reading the validators' volumes; from release.env, pinned like every image (implement/28 Q1.1).
ALPINE="$(sed -n 's/^ALPINE_IMAGE=//p' "${RELEASE_FILE:-$ROOT/infra/compose/release.env}" | tail -1)"
export ENV

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$BACKUP_DIR/.incomplete-$stamp"
dest="$BACKUP_DIR/$stamp"

umask 077
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

recipients="$work/.recipients"
age-keygen -y "$ROOT/secrets/age.key" > "$recipients"
if [ -f "$OFFLINE_RECIPIENTS" ]; then
  grep -E '^age1' "$OFFLINE_RECIPIENTS" >> "$recipients"
else
  echo "warning: $OFFLINE_RECIPIENTS missing; encrypting to the VM key only" >&2
fi

encrypt() { age -R "$recipients" > "$work/$1"; }
check_size() { # age output of an empty pipe is still a few hundred bytes; a real dump is far larger.
  [ "$(stat -c %s "$work/$1")" -ge 1024 ] || { echo "backup $1 looks empty" >&2; exit 1; }
}

for db in drizzle message_pickup mediator; do
  "$DEPLOY" mediator exec -T postgres pg_dump -U postgres --format=custom "$db" | encrypt "$db.dump.age"
  check_size "$db.dump.age"
done
"$DEPLOY" mediator exec -T postgres pg_dumpall -U postgres --globals-only | encrypt globals.sql.age

if "$DEPLOY" agent ps --status running agent-postgres | grep -q agent-postgres; then
  for db in agent_root agent_service endorser endorser_service platform_api console biometric; do
    "$DEPLOY" agent exec -T agent-postgres pg_dump -U postgres --format=custom "$db" | encrypt "agent-$db.dump.age"
    check_size "agent-$db.dump.age"
  done
  "$DEPLOY" agent exec -T agent-postgres pg_dumpall -U postgres --globals-only | encrypt agent-globals.sql.age
fi

# Our own validators (production). Copied live: a node restored from a slightly older copy catches up
# from the other three; what cannot be recreated are the node keys, which are in here.
for n in 1 2 3 4; do
  volume="12id-ledger-node$n-data"
  docker volume inspect "$volume" > /dev/null 2>&1 || continue
  [ -n "$ALPINE" ] || { echo "ALPINE_IMAGE is missing from release.env; cannot back up $volume" >&2; exit 1; }
  docker run --rm --network none -v "$volume:/data:ro" "$ALPINE" tar -C /data -czf - . | encrypt "ledger-node$n.tar.gz.age"
  check_size "ledger-node$n.tar.gz.age"
done

if [ -d "$GENESIS_DIR" ]; then
  tar -C "$GENESIS_DIR" -czf - . | encrypt genesis.tar.gz.age
fi

rm -f "$recipients"
(cd "$work" && sha256sum -- *.age > SHA256SUMS)
mv "$work" "$dest"
trap - EXIT

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '2*' -mtime +"$KEEP_DAYS" -exec rm -rf -- {} +
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '.incomplete-*' -mmin +720 -exec rm -rf -- {} +

echo "backup $stamp: $(du -sh "$dest" | cut -f1) in $dest, $(wc -l < "$dest/SHA256SUMS") files"
