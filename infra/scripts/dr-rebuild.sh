#!/usr/bin/env bash
# Whole-VM disaster recovery, scripted (Phase 9 W4, runbooks/disaster-recovery.md "The whole VM"): rebuild an
# environment on a fresh host from the repo's infra tree, a backup pulled by the backup machine, and the
# environment's offline age key only. Rehearsed for staging on 2026-10-04 in a WSL distro (19-…findings W4 D3).
#
#   ENV=staging OFFLINE_KEY=/media/offline/staging-offline-age.key REPO=/path/to/unpacked/repo \
#   BACKUPS=/srv/12id-backups dr-rebuild.sh prep|restore|deploy|check
#
#   prep      /opt/12id from REPO, a new host age key, every sops file re-keyed to it with the offline key, the
#             genesis from the backup. REHEARSAL=1 (no public DNS/ACME on the host): the environment's hostnames
#             point at 127.0.0.1 and Caddy issues its own certificates (EDGE_TLS=internal).
#   restore   the two Postgres instances, roles, every dump of the newest backup, roles again
#   deploy    every stack in the bring-up order (the host needs a GHCR read login first)
#   check     health, row counts, edge probes
# Production adds the ledger: restore the validators' volumes (ledger-node*.tar.gz.age) before deploying
# ledger-nodes (disaster-recovery.md step 3); this script does not do that yet.
set -euo pipefail
R=/opt/12id
OFFLINE="${OFFLINE_KEY:?OFFLINE_KEY=the environment's offline age key}"
REPO="${REPO:?REPO=an unpacked copy of the repo (infra/ and .sops.yaml)}"
BACKUPS="${BACKUPS:-/srv/12id-backups}"
B="$BACKUPS/daily/$(ls "$BACKUPS/daily" | grep -E '^[0-9]{8}T' | tail -1)"
export ENV="${ENV:?ENV=staging|production}"
S=$R/infra/scripts
setting() { sed -n "s/^$1=//p" "$R/infra/env/$ENV.env"; }

stage_prep() {
  rm -rf "$R" && mkdir -p "$R/secrets" "$R/genesis" "$R/metrics" "$R/backups"
  cp -a "$REPO/infra" "$R/infra" && cp "$REPO/.sops.yaml" "$R/.sops.yaml"
  chmod +x "$R"/infra/scripts/*.sh
  (cd "$B" && sha256sum -c --quiet SHA256SUMS) && echo "backup $B: checksums ok"
  # A new host key; the secrets are re-keyed to it with the offline key (the old VM key is lost with the VM).
  (umask 077; age-keygen -o "$R/secrets/age.key" 2>/dev/null)
  local new old f
  new=$(age-keygen -y "$R/secrets/age.key")
  old=$(grep -oE 'age1[a-z0-9]+' "$R/.sops.yaml" | head -1)
  sed -i "s/$old/$new/" "$R/.sops.yaml"
  for f in "$R"/infra/env/"$ENV"/secrets/*.sops.env; do
    (cd "$R" && SOPS_AGE_KEY_FILE="$OFFLINE" sops updatekeys -y "$f" >/dev/null 2>&1) && echo "re-keyed $(basename "$f")"
  done
  age -d -i "$OFFLINE" "$B/genesis.tar.gz.age" | tar -xz -C "$R/genesis"
  chmod -R a+rX "$R/genesis"
  echo "genesis: $(ls "$R/genesis" | tr '\n' ' ')"
  if [ "${REHEARSAL:-}" = 1 ]; then
    local h hosts=""
    for h in CONSOLE_HOST API_HOST AGENT_HOST MEDIATOR_HOST GENESIS_HOST VDR_HOST; do hosts+=" $(setting $h)"; done
    for h in $hosts; do sed -i "/[[:space:]]$h\([[:space:]]\|$\)/d" /etc/hosts; done
    echo "127.0.0.1$hosts" >> /etc/hosts
    sed -i '/^EDGE_TLS=/d' "$R/infra/env/$ENV.env" && echo 'EDGE_TLS=internal' >> "$R/infra/env/$ENV.env"
    echo "rehearsal: hostnames on 127.0.0.1, Caddy's own CA (EDGE_TLS=internal)"
  fi
}

stage_restore() {
  "$S/deploy.sh" mediator up -d postgres valkey 2>&1 | grep -iE "error|Started" || true
  "$S/deploy.sh" agent up -d agent-postgres 2>&1 | grep -iE "error|Started" || true
  local c
  for c in mediator-postgres-1 agent-agent-postgres-1; do
    until [ "$(docker inspect -f '{{.State.Health.Status}}' $c 2>/dev/null)" = healthy ]; do sleep 2; done
  done
  "$S/pg-roles.sh" all 2>&1 | tail -3
  local t0 f db container
  t0=$(date +%s)
  for f in "$B"/*.dump.age; do
    db=$(basename "$f" .dump.age)
    container=mediator-postgres-1
    case "$db" in agent-*) db=${db#agent-}; container=agent-agent-postgres-1 ;; esac
    docker exec "$container" psql -U postgres -qc "drop database if exists \"$db\" with (force)" >/dev/null
    age -d -i "$OFFLINE" "$f" | docker exec -i "$container" pg_restore -U postgres --create --dbname=postgres 2>&1 \
      | grep -vE "role .* does not exist|could not execute query|^Command was|errors ignored" | head -3 || true
    echo "restored $db into $container"
  done
  # Again: the restored objects belong to the service roles, and the monitoring grants find their tables.
  "$S/pg-roles.sh" all 2>&1 | tail -3
  echo "restore took $(( $(date +%s) - t0 ))s"
}

stage_deploy() {
  local t0 s
  t0=$(date +%s)
  "$S/deploy.sh" mediator up -d 2>&1 | grep -iE "error" || true
  "$S/check-mediator-tables.sh" --after-start 2>&1 | tail -2 || true
  for s in agent biometric platform console monitoring edge; do "$S/deploy.sh" $s up -d 2>&1 | grep -iE "error" || true; done
  echo "deploy took $(( $(date +%s) - t0 ))s"
}

stage_check() {
  docker ps --format '{{.Names}}\t{{.Status}}' | sort
  local checks=(
    "agent-agent-postgres-1|platform_api|select count(*) from tenants"
    "agent-agent-postgres-1|platform_api|select count(*) from wallets"
    "agent-agent-postgres-1|agent_root|select count(*) from agent_service.items"
    "agent-agent-postgres-1|console|select count(*) from \"user\""
    "mediator-postgres-1|drizzle|select count(*) from \"DidcommMediation\""
    "mediator-postgres-1|message_pickup|select count(*) from queued_message"
  )
  local c container db q
  for c in "${checks[@]}"; do
    IFS='|' read -r container db q <<< "$c"
    echo "$db: $q = $(docker exec "$container" psql -U postgres -d "$db" -Atc "$q")"
  done
  local ca=/root/dr-caddy-root.crt cacert=()
  if [ "${REHEARSAL:-}" = 1 ]; then
    docker exec edge-caddy-1 cat /data/caddy/pki/authorities/local/root.crt > "$ca" 2>/dev/null && cacert=(--cacert "$ca")
  fi
  local u
  for u in "https://$(setting GENESIS_HOST)/$(setting GENESIS_VERSION)/pool_transactions_genesis" "https://$(setting MEDIATOR_HOST)/health" \
           "https://$(setting AGENT_HOST)/readyz" "https://$(setting API_HOST)/v1/health" "https://$(setting API_HOST)/v1/ledger" \
           "https://$(setting CONSOLE_HOST)/api/health" "https://$(setting VDR_HOST)/genesis"; do
    printf '%s %s\n' "$(curl -s -o /dev/null -m 15 "${cacert[@]}" -w '%{http_code}' "$u")" "$u"
  done
}

"stage_${1:?usage: dr-rebuild.sh prep|restore|deploy|check}"
