#!/usr/bin/env bash
# Sets one key in an encrypted secrets file without an editor and without the value ever appearing
# on screen, in shell history or on disk in plain text (only in /dev/shm, shredded at exit).
#
#   infra/scripts/set-secret.sh monitoring GMAIL_APP_PASSWORD
#
# Prompts for the value (hidden). Spaces are removed (Google shows app passwords in groups of four).
set -euo pipefail

STACK="${1:?usage: set-secret.sh <stack> <KEY>}"
KEY="${2:?usage: set-secret.sh <stack> <KEY>}"
[[ "$KEY" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "KEY must look like SOME_NAME" >&2; exit 1; }

ROOT="${ROOT:-/opt/12id}"
cd "$ROOT"
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$ROOT/secrets/age.key}"
file="infra/staging/secrets/$STACK.sops.env"
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }

read -rs -p "Value for $KEY (hidden): " value; echo
value="${value// /}"
[ -n "$value" ] || { echo "empty value, nothing changed" >&2; exit 1; }

tmp="$(mktemp -p /dev/shm secret.XXXXXX)"
chmod 600 "$tmp"
trap 'shred -u "$tmp" 2>/dev/null || rm -f "$tmp"; unset value' EXIT

sops --decrypt --input-type dotenv --output-type dotenv "$file" | grep -v "^$KEY=" > "$tmp"
printf '%s=%s\n' "$KEY" "$value" >> "$tmp"
sops --encrypt --filename-override "$file" --input-type dotenv --output-type dotenv "$tmp" > "$file.new"
mv "$file.new" "$file"

echo "Saved. Keys in $file now:"
sops --decrypt --input-type dotenv --output-type dotenv "$file" | cut -d= -f1 | sed 's/^/  /'
