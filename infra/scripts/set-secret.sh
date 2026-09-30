#!/usr/bin/env bash
# Sets one key in an encrypted secrets file without an editor and without the value ever appearing
# on screen, in shell history or on disk in plain text (only in /dev/shm, shredded at exit).
#
#   infra/scripts/set-secret.sh monitoring GMAIL_APP_PASSWORD
#   infra/scripts/set-secret.sh agent AGENT_INTERNAL_TOKEN --unset     # remove a retired key
#   infra/scripts/set-secret.sh ledger LEDGER_PROBE_SEED --generate    # random, never shown
#   ENV=production infra/scripts/set-secret.sh ...                     # default: staging
#
# Prompts for the value (hidden). Spaces are removed (Google shows app passwords in groups of four).
# --generate needs no prompt: 64 hex characters from openssl, which every token, password and seed
# here accepts. The file is created if the stack has none yet (Phase 9 W2). Afterwards run deploy.sh
# for the stacks that use the key: it rewrites the files under /opt/12id/run-secrets.
set -euo pipefail

usage='usage: [ENV=staging|production] set-secret.sh <stack> <KEY> [--unset|--generate]'
STACK="${1:?$usage}"
KEY="${2:?$usage}"
MODE="${3:-set}"
[[ "$KEY" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "KEY must look like SOME_NAME" >&2; exit 1; }
[[ "$MODE" == set || "$MODE" == --unset || "$MODE" == --generate ]] || { echo "$usage" >&2; exit 1; }

ENV="${ENV:-staging}"
ROOT="${ROOT:-/opt/12id}"
cd "$ROOT"
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$ROOT/secrets/age.key}"
file="infra/env/$ENV/secrets/$STACK.sops.env"
[ -d "$(dirname "$file")" ] || { echo "no such environment: $(dirname "$file")" >&2; exit 1; }

value=''
case "$MODE" in
  set)
    read -rs -p "Value for $KEY (hidden): " value; echo
    value="${value// /}"
    [ -n "$value" ] || { echo "empty value, nothing changed" >&2; exit 1; }
    ;;
  --generate) value="$(openssl rand -hex 32)" ;;
esac

tmp="$(mktemp -p /dev/shm secret.XXXXXX)"
chmod 600 "$tmp"
trap 'shred -u "$tmp" 2>/dev/null || rm -f "$tmp"; unset value' EXIT

decrypt() { [ -f "$file" ] && sops --decrypt --input-type dotenv --output-type dotenv "$file"; }

decrypt | grep -v "^$KEY=" > "$tmp" || true
if [ "$MODE" = --unset ]; then
  decrypt | grep -q "^$KEY=" || { echo "$KEY is not in $file, nothing changed" >&2; exit 1; }
else
  printf '%s=%s\n' "$KEY" "$value" >> "$tmp"
fi
sops --encrypt --filename-override "$file" --input-type dotenv --output-type dotenv "$tmp" > "$file.new"
mv "$file.new" "$file"

echo "Saved. Keys in $file now:"
decrypt | cut -d= -f1 | sed 's/^/  /'
