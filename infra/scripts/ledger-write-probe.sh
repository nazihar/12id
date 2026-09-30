#!/usr/bin/env bash
# Ledger write probe (W7). Proves the pool reaches consensus, which reachability probes
# cannot: in W1 all four client ports answered and the ledger reported ready while every
# write failed with "Pool timeout".
#
# Staging (von-network) only: writes one role-less NYM through the trustee-backed /register
# endpoint on 127.0.0.1:9000 and waits until it can be read back from the domain ledger.
# Every run adds one permanent NYM transaction, so it runs every 15 minutes from
# 12id-ledger-probe.timer, not on each Prometheus scrape.
#
# Output: Prometheus textfile metrics for node-exporter's textfile collector.
set -uo pipefail

# Phase 9 W2: an environment with its own Indy network (LEDGER_NETWORK_NAME set in its env file) uses
# the ledger-tools probe instead: an attribute write on the probe's own role-less DID, read back
# (infra/ledger/src/write-probe.ts). It writes the same metrics, so the alerts are unchanged.
ENV="${ENV:-staging}"
if grep -qE '^LEDGER_NETWORK_NAME=.+' "/opt/12id/infra/env/$ENV.env" 2>/dev/null; then
  exec env ENV="$ENV" /opt/12id/infra/scripts/deploy.sh ledger run --rm -T write-probe
fi

LEDGER_URL="${LEDGER_URL:-http://127.0.0.1:9000}"
OUT_DIR="${OUT_DIR:-/opt/12id/metrics}"
READBACK_TIMEOUT_S="${READBACK_TIMEOUT_S:-60}"

mkdir -p "$OUT_DIR"
started=$(date +%s.%N)
success=0
did=""

seed=$(head -c 64 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 32)
response=$(curl -s -m 45 -X POST "$LEDGER_URL/register" \
  -H 'Content-Type: application/json' \
  -d "{\"seed\":\"$seed\",\"role\":null,\"alias\":\"12id-write-probe\"}") || response=""
did=$(printf '%s' "$response" | grep -oE '"did": *"[^"]+"' | cut -d'"' -f4)

if [ -n "$did" ]; then
  deadline=$(( $(date +%s) + READBACK_TIMEOUT_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -s -m 10 "$LEDGER_URL/ledger/domain?query=$did&type=1" | grep -q "$did"; then
      success=1
      break
    fi
    sleep 3
  done
fi

duration=$(awk -v s="$started" -v e="$(date +%s.%N)" 'BEGIN { printf "%.3f", e - s }')

# Write atomically: the collector only reads *.prom, so the temp name is ignored.
tmp="$OUT_DIR/ledger_write_probe.prom.$$"
cat > "$tmp" <<EOF
# HELP ledger_write_probe_success 1 if a NYM write reached consensus and was read back.
# TYPE ledger_write_probe_success gauge
ledger_write_probe_success $success
# HELP ledger_write_probe_duration_seconds Seconds from submitting the write to reading it back, or to giving up.
# TYPE ledger_write_probe_duration_seconds gauge
ledger_write_probe_duration_seconds $duration
# HELP ledger_write_probe_last_run_timestamp_seconds Unix time of the last probe run.
# TYPE ledger_write_probe_last_run_timestamp_seconds gauge
ledger_write_probe_last_run_timestamp_seconds $(date +%s)
EOF
chmod 0644 "$tmp"
mv "$tmp" "$OUT_DIR/ledger_write_probe.prom"

if [ "$success" = 1 ]; then
  echo "ledger write probe OK: $did in ${duration}s"
else
  echo "ledger write probe FAILED after ${duration}s: ${response:0:160}" >&2
  exit 1
fi
