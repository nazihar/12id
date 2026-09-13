#!/usr/bin/env bash
# Runs docker compose for one staging stack, with its secrets decrypted only into tmpfs (W9).
#
#   deploy.sh <stack> [compose args...]     default args: up -d
#   deploy.sh mediator
#   deploy.sh mediator logs -f mediator-1
#
# <stack> selects compose.<stack>.yml; if secrets/<stack>.sops.env exists it is decrypted to
# /dev/shm, passed as --env-file for interpolation, and shredded on exit. Containers keep the
# values they were created with, so nothing decrypted outlives the command.
set -euo pipefail

STACK="${1:?usage: deploy.sh <edge|mediator|monitoring|...> [compose args]}"
shift

ROOT="${ROOT:-/opt/12id/infra/staging}"
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-/opt/12id/secrets/age.key}"

compose="$ROOT/compose.$STACK.yml"
secrets="$ROOT/secrets/$STACK.sops.env"
[ -f "$compose" ] || { echo "no such stack: $compose" >&2; exit 2; }

# EXTRA_SECRETS="mediator other" adds secrets/<name>.sops.env for stacks that need values
# owned by another stack (e.g. the ledger tools need the mediator stack's POSTGRES_PASSWORD).
files=()
[ -f "$secrets" ] && files+=("$secrets")
for extra in ${EXTRA_SECRETS:-}; do
  f="$ROOT/secrets/$extra.sops.env"
  [ -f "$f" ] || { echo "no such secrets file: $f" >&2; exit 2; }
  files+=("$f")
done

args=(-f "$compose")
if [ ${#files[@]} -gt 0 ]; then
  dec="$(mktemp -p /dev/shm "12id-$STACK.XXXXXX")"
  trap 'shred -u "$dec" 2>/dev/null || rm -f "$dec"' EXIT
  chmod 600 "$dec"
  for f in "${files[@]}"; do
    sops --decrypt --input-type dotenv --output-type dotenv "$f" >> "$dec"
  done
  args+=(--env-file "$dec")
fi

[ $# -gt 0 ] || set -- up -d

cd "$ROOT"
docker compose "${args[@]}" "$@"
