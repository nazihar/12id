#!/usr/bin/env bash
# Sets one key in an encrypted secrets file without an editor and without the value ever appearing
# on screen, in shell history or on disk in plain text (only in /dev/shm, shredded at exit).
#
#   infra/scripts/set-secret.sh monitoring GMAIL_APP_PASSWORD
#   infra/scripts/set-secret.sh agent AGENT_INTERNAL_TOKEN --unset     # remove a retired key
#   infra/scripts/set-secret.sh ledger LEDGER_PROBE_SEED --generate    # random, never shown
#   ENV=production infra/scripts/set-secret.sh ...                     # default: staging
#
# Rotation (Phase 9 W4, runbooks/key-rotation.md):
#   infra/scripts/set-secret.sh platform,console CONSOLE_TOKEN --generate
#       the same value in every listed stack (a token both ends must share);
#   infra/scripts/set-secret.sh platform MEDIATOR_WEBHOOK_SECRET --generate \
#       --also 'mediator:MEDIATOR_WEBHOOK_URL=http://platform-api:3500/internal/mediator/{}'
#       also writes a derived key, with {} replaced by the value, into another stack's file;
#   infra/scripts/set-secret.sh biometric BIOMETRIC_MASTER_KEY_NEXT --generate-base64
#       32 random bytes, base64 (the biometric master key's format);
#   infra/scripts/set-secret.sh biometric BIOMETRIC_MASTER_KEY --from BIOMETRIC_MASTER_KEY_NEXT
#       copies another key of the (first) stack's file: promotes a rotated value without showing it.
#
# Prompts for the value (hidden). Spaces are removed (Google shows app passwords in groups of four).
# --generate needs no prompt: 64 hex characters from openssl, which every token, password and seed
# here accepts. A file is created if the stack has none yet (Phase 9 W2). Afterwards run deploy.sh
# for the stacks that use the key: it rewrites the files under /opt/12id/run-secrets.
set -euo pipefail

usage='usage: [ENV=staging|production] set-secret.sh <stack>[,<stack>…] <KEY> [--unset|--generate|--generate-base64|--from <KEY>] [--also <stack>:<KEY>=<template with {}>]…'
STACKS="${1:?$usage}"
KEY="${2:?$usage}"
shift 2
MODE=set
FROM=''
ALSO=()
while [ $# -gt 0 ]; do
  case "$1" in
    --unset|--generate|--generate-base64) MODE="$1"; shift ;;
    --from) MODE=--from; FROM="${2:?$usage}"; shift 2 ;;
    --also) ALSO+=("${2:?$usage}"); shift 2 ;;
    *) echo "$usage" >&2; exit 1 ;;
  esac
done
[[ "$KEY" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "KEY must look like SOME_NAME" >&2; exit 1; }
[ "$MODE" != --from ] || [[ "$FROM" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "--from takes a KEY" >&2; exit 1; }
[ "$MODE" != --unset ] || [ ${#ALSO[@]} -eq 0 ] || { echo "--also cannot be combined with --unset" >&2; exit 1; }
for also in "${ALSO[@]}"; do
  [[ "$also" =~ ^[a-z][a-z0-9-]*:[A-Z][A-Z0-9_]*=.*\{\}.*$ ]] || { echo "--also must look like stack:KEY=prefix{}suffix" >&2; exit 1; }
done

ENV="${ENV:-staging}"
ROOT="${ROOT:-/opt/12id}"
cd "$ROOT"
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$ROOT/secrets/age.key}"
dir="infra/env/$ENV/secrets"
[ -d "$dir" ] || { echo "no such environment: $dir" >&2; exit 1; }

value=''
case "$MODE" in
  set)
    # A piped value without a final newline still counts (read returns non-zero at end of input).
    read -rs -p "Value for $KEY (hidden): " value || [ -n "$value" ]; echo
    value="${value// /}"
    [ -n "$value" ] || { echo "empty value, nothing changed" >&2; exit 1; }
    ;;
  --generate) value="$(openssl rand -hex 32)" ;;
  --generate-base64) value="$(openssl rand -base64 32)" ;;
  --from)
    value="$(sops --decrypt --input-type dotenv --output-type dotenv "$dir/${STACKS%%,*}.sops.env" | sed -n "s/^$FROM=//p")"
    [ -n "$value" ] || { echo "$FROM is not in $dir/${STACKS%%,*}.sops.env, nothing changed" >&2; exit 1; }
    ;;
esac

tmp="$(mktemp -p /dev/shm secret.XXXXXX)"
chmod 600 "$tmp"
trap 'shred -u "$tmp" 2>/dev/null || rm -f "$tmp"; unset value' EXIT

decrypt() { [ -f "$1" ] && sops --decrypt --input-type dotenv --output-type dotenv "$1"; }

# write_key <stack> <KEY> <value>|--unset
write_key() {
  local file="$dir/$1.sops.env" key="$2" new="$3"
  decrypt "$file" | grep -v "^$key=" > "$tmp" || true
  if [ "$new" = --unset ]; then
    decrypt "$file" | grep -q "^$key=" || { echo "$key is not in $file, nothing changed" >&2; exit 1; }
  else
    printf '%s=%s\n' "$key" "$new" >> "$tmp"
  fi
  sops --encrypt --filename-override "$file" --input-type dotenv --output-type dotenv "$tmp" > "$file.new"
  mv "$file.new" "$file"
  : > "$tmp"
  echo "Saved $key in $file. Keys there now:"
  decrypt "$file" | cut -d= -f1 | sed 's/^/  /'
}

IFS=',' read -r -a stack_list <<< "$STACKS"
for stack in "${stack_list[@]}"; do
  [[ "$stack" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "bad stack name: $stack" >&2; exit 1; }
  if [ "$MODE" = --unset ]; then write_key "$stack" "$KEY" --unset; else write_key "$stack" "$KEY" "$value"; fi
done
for also in "${ALSO[@]}"; do
  stack="${also%%:*}"
  rest="${also#*:}"
  template="${rest#*=}"
  # Bash substitution, not sed: the value must never be a process argument.
  write_key "$stack" "${rest%%=*}" "${template//'{}'/$value}"
done
