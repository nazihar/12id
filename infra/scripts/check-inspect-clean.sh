#!/usr/bin/env bash
# Go-live check for review M11 (Phase 9 W2): no secret value appears in any container's configuration.
#
#   ENV=staging infra/scripts/check-inspect-clean.sh
#
# Decrypts every SOPS file of the environment into this process only, then searches the full
# `docker inspect` output of every container (running or not) for each value of 8 characters or
# more, and for the value inside a URL's userinfo (percent-encoded). Prints the container and key
# of every hit, never the value. Exit 0 when clean.
set -euo pipefail

ENV="${ENV:-staging}"
ROOT="${ROOT:-/opt/12id}"
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$ROOT/secrets/age.key}"
dir="$ROOT/infra/env/$ENV/secrets"

work="$(mktemp -d -p /dev/shm 12id-inspect.XXXXXX)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

for c in $(docker ps -aq); do
  docker inspect "$c" > "$work/$c.json"
done

hits=0
checked=0
for f in "$dir"/*.sops.env; do
  stack="$(basename "$f" .sops.env)"
  while IFS= read -r line; do
    key="${line%%=*}"
    value="${line#*=}"
    [ ${#value} -ge 8 ] || continue
    checked=$((checked + 1))
    encoded="$(python3 -c 'import sys, urllib.parse; sys.stdout.write(urllib.parse.quote(sys.argv[1], safe=""))' "$value")"
    for j in "$work"/*.json; do
      if grep -qF -- "$value" "$j" || grep -qF -- "$encoded" "$j"; then
        name="$(sed -n 's/^ *"Name": "\/\([^"]*\)".*/\1/p' "$j" | head -1)"
        echo "EXPOSED: $stack/$key in container $name"
        hits=$((hits + 1))
      fi
    done
  done < <(sops --decrypt --input-type dotenv --output-type dotenv "$f")
done

containers="$(ls "$work"/*.json 2>/dev/null | wc -l)"
if [ "$hits" -eq 0 ]; then
  echo "clean: $checked secret values, $containers containers, 0 found in docker inspect"
else
  echo "$hits exposure(s) across $containers containers" >&2
  exit 1
fi
