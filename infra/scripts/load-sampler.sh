#!/usr/bin/env bash
# W4 load test: what Prometheus does not already see, as node-exporter textfile metrics every
# INTERVAL seconds (default 15) for DURATION seconds (default 4 h), then the file is removed.
# Run on the VM for the length of a load run:
#   sudo nohup /opt/12id/infra/scripts/load-sampler.sh > /tmp/load-sampler.log 2>&1 &
#
# - established TCP connections on the edge (:443) and to the mediator replicas (:3001/:3002):
#   the client and upstream side of the WebSocket/HTTP keep-alive count;
# - Postgres backends per database and state, on the mediator and agent instances (connection
#   pressure: both run with the stock max_connections = 100).
# CPU, memory, restarts, the queue and Caddy's request rates come from cadvisor, node-exporter,
# postgres-exporter and Caddy's own metrics already.
set -uo pipefail

INTERVAL="${INTERVAL:-15}"
DURATION="${DURATION:-14400}"
OUT_DIR="${OUT_DIR:-/opt/12id/metrics}"
OUT="$OUT_DIR/load_sampler.prom"
MEDIATOR_PG="${MEDIATOR_PG:-mediator-postgres-1}"
AGENT_PG="${AGENT_PG:-$(docker ps --format '{{.Names}}' | grep -m1 'agent-postgres')}"

trap 'rm -f "$OUT"' EXIT

established() {
  # ss counts both directions on loopback; filter on the local (listening) port only.
  ss -Htn state established "( sport = :$1 )" 2>/dev/null | wc -l
}

backends() {
  local container="$1" instance="$2"
  [ -n "$container" ] || return 0
  docker exec "$container" psql -U postgres -Atc \
    "select coalesce(datname,'-'), coalesce(state,'-'), count(*) from pg_stat_activity where backend_type = 'client backend' group by 1,2" 2>/dev/null |
    while IFS='|' read -r db state count; do
      printf 'load_pg_backends{instance="%s",datname="%s",state="%s"} %s\n' "$instance" "$db" "$state" "$count"
    done
}

end=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$end" ]; do
  tmp="$OUT.$$"
  {
    echo '# HELP load_tcp_established Established TCP connections by local port (W4 load sampler).'
    echo '# TYPE load_tcp_established gauge'
    for port in 443 3001 3002; do
      printf 'load_tcp_established{port="%s"} %s\n' "$port" "$(established "$port")"
    done
    echo '# HELP load_pg_backends Postgres client backends by database and state (W4 load sampler).'
    echo '# TYPE load_pg_backends gauge'
    backends "$MEDIATOR_PG" mediator
    backends "$AGENT_PG" agent
  } > "$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$OUT"
  sleep "$INTERVAL"
done
