#!/usr/bin/env bash
# Runs on the backup machine at another site (Phase 9 W2, review M13): pulls the VM's encrypted
# backups over SSH, verifies them, and keeps 30 daily + 12 monthly copies.
#
#   SOURCE=backup@12id-prod DEST=/srv/12id-backups SSH_KEY=~/.ssh/12id-backup-pull backup-pull.sh
#
# The pull is one-way and read-only by construction: the VM's authorized_keys line for this key is
#   command="rrsync -ro /opt/12id/backups",restrict ssh-ed25519 AAAA... 12id-backup-pull
# so the key can read that directory and nothing else, and a compromised VM cannot reach or delete the
# copies here. The backups are age-encrypted on the VM; this machine never holds a key that decrypts
# them (the offline key is kept offline, runbooks/backup-restore.md).
#
# Nothing already here is overwritten (--ignore-existing) and nothing is deleted because it disappeared
# on the VM (no --delete): the VM's own 7-day rotation never reaches this copy.
#
# Exit status: 0 ok; 1 a transfer or checksum failed; 2 the newest backup is older than MAX_AGE_HOURS.
# Run it from cron or a systemd timer that mails its output on failure. It also writes
# $DEST/last-pull.prom for a node-exporter textfile collector, if the machine has one.
set -euo pipefail

SOURCE="${SOURCE:?SOURCE=user@host of the VM}"
DEST="${DEST:?DEST=local directory for the copies}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/12id-backup-pull}"
SSH_PORT="${SSH_PORT:-22}"
KEEP_DAILY="${KEEP_DAILY:-30}"
KEEP_MONTHLY="${KEEP_MONTHLY:-12}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"

mkdir -p "$DEST/daily"
status=0

# Complete backups only: the VM renames .incomplete-<stamp> to <stamp> when a backup is finished.
rsync -a --ignore-existing --exclude '.incomplete-*' --exclude '.*' \
  -e "ssh -i $SSH_KEY -p $SSH_PORT -o BatchMode=yes -o IdentitiesOnly=yes" \
  "$SOURCE:/" "$DEST/daily/" || status=1

# Verify every copy once; a verified copy is marked so the next run skips it.
for dir in "$DEST"/daily/2*/; do
  dir="${dir%/}"
  [ -f "$dir/.verified" ] && continue
  if (cd "$dir" && sha256sum --quiet -c SHA256SUMS); then
    touch "$dir/.verified"
  else
    echo "checksum mismatch in $dir" >&2
    status=1
  fi
done

# Retention: every backup of the last KEEP_DAILY days, plus the first backup of each of the last
# KEEP_MONTHLY months. Stamps are UTC, YYYYMMDDTHHMMSSZ.
now="$(date -u +%s)"
daily_cutoff="$(date -u -d "@$((now - KEEP_DAILY * 86400))" +%Y%m%d)"
declare -A first_of_month
for dir in "$DEST"/daily/2*/; do
  stamp="$(basename "$dir")"
  month="${stamp:0:6}"
  [ -z "${first_of_month[$month]:-}" ] && first_of_month[$month]="$stamp"
done
keep_months="$(for m in "${!first_of_month[@]}"; do echo "$m"; done | sort -r | head -n "$KEEP_MONTHLY")"
for dir in "$DEST"/daily/2*/; do
  stamp="$(basename "$dir")"
  if [[ ! "${stamp:0:8}" < "$daily_cutoff" ]]; then continue; fi
  month="${stamp:0:6}"
  if [ "${first_of_month[$month]}" = "$stamp" ] && grep -qx "$month" <<< "$keep_months"; then
    continue
  fi
  rm -rf -- "${dir%/}"
done

newest="$(ls -1 "$DEST/daily" | grep -E '^2[0-9]{7}T[0-9]{6}Z$' | sort | tail -1 || true)"
age_hours=999999
if [ -n "$newest" ]; then
  newest_s="$(date -u -d "${newest:0:4}-${newest:4:2}-${newest:6:2}T${newest:9:2}:${newest:11:2}:${newest:13:2}Z" +%s)"
  age_hours=$(( (now - newest_s) / 3600 ))
fi
if [ "$age_hours" -gt "$MAX_AGE_HOURS" ]; then
  echo "newest backup is ${age_hours} h old (${newest:-none}); the VM's nightly backup or this pull is failing" >&2
  [ "$status" -eq 0 ] && status=2
fi

cat > "$DEST/last-pull.prom.tmp" <<EOF
# HELP backup_pull_success 1 if the last pull and verification succeeded.
# TYPE backup_pull_success gauge
backup_pull_success $([ "$status" -eq 0 ] && echo 1 || echo 0)
# HELP backup_pull_newest_age_hours Age of the newest backup held here.
# TYPE backup_pull_newest_age_hours gauge
backup_pull_newest_age_hours $age_hours
# HELP backup_pull_copies Backups held here.
# TYPE backup_pull_copies gauge
backup_pull_copies $(ls -1 "$DEST/daily" | grep -cE '^2' || true)
EOF
mv "$DEST/last-pull.prom.tmp" "$DEST/last-pull.prom"

echo "backup pull: newest ${newest:-none} (${age_hours} h), $(ls -1 "$DEST/daily" | grep -cE '^2' || true) copies, status $status"
exit "$status"
