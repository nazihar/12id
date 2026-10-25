#!/usr/bin/env bash
# Checks infra/compose/secrets.list against the compose files (implement/28 Q1.6), so the two cannot drift:
# every secret a compose file mounts (`file: ${RUN_SECRETS}/<stack>/<KEY>`) must be listed, and every listed
# one must be mounted somewhere. Also checks the kinds, the derived templates, that a key shared by several
# stacks has one kind, and that the database passwords pg-roles.sh sets are generated.
#
#   infra/scripts/check-secrets-list.sh          exit 0 when consistent
#
# Runs anywhere bash runs (CI, the dev PC); it reads files only.
set -euo pipefail

BUNDLE="${BUNDLE:-$(cd "$(dirname "$0")/../compose" && pwd)}"
LIST="$BUNDLE/secrets.list"
errors=0
err() { echo "secrets.list: $*" >&2; errors=$((errors + 1)); }

declare -A listed kind_of derived_ref
while read -r stack key kind template; do
  [[ -z "$stack" || "$stack" == \#* ]] && continue
  [[ "$stack" =~ ^[a-z][a-z0-9-]*$ ]] || err "bad stack name '$stack'"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || err "bad key '$key'"
  case "$kind" in
    generate|base64|prompt|optional|empty) [ -z "$template" ] || err "$stack/$key: only derived takes a template" ;;
    derived) [[ "$template" =~ \{[A-Z][A-Z0-9_]*\} ]] || err "$stack/$key: derived needs a template with {KEY}" ;;
    *) err "$stack/$key: unknown kind '$kind'" ;;
  esac
  [ -z "${listed[$stack/$key]:-}" ] || err "$stack/$key listed twice"
  listed[$stack/$key]="$kind"
  if [ -n "${kind_of[$key]:-}" ] && [ "${kind_of[$key]}" != "$kind" ]; then
    err "$key has kinds ${kind_of[$key]} and $kind; a shared key is one value"
  fi
  kind_of[$key]="$kind"
  if [ "$kind" = derived ]; then
    ref="${template#*\{}"
    derived_ref[$stack/$key]="${ref%%\}*}"
  fi
done < "$LIST"
for pair in "${!derived_ref[@]}"; do
  ref="${derived_ref[$pair]}"
  case "${kind_of[$ref]:-}" in
    generate|base64|prompt) ;;
    '') err "$pair: {$ref} is not listed" ;;
    *) err "$pair: {$ref} must be generate, base64 or prompt, not ${kind_of[$ref]}" ;;
  esac
done

declare -A mounted
while read -r pair; do
  mounted[$pair]=1
done < <(grep -ohE 'file: *\$\{RUN_SECRETS[^}]*\}/[a-z0-9-]+/[A-Z][A-Z0-9_]*' "$BUNDLE"/compose.*.yml | sed 's#^.*}/##' | sort -u)

for pair in "${!mounted[@]}"; do
  [ -n "${listed[$pair]:-}" ] || err "$pair is mounted by a compose file but not listed"
done
for pair in "${!listed[@]}"; do
  [ -n "${mounted[$pair]:-}" ] || err "$pair is listed but no compose file mounts it"
done

# pg-roles.sh refuses anything but [A-Za-z0-9]{24,}; generated values are 64 hex characters.
for key in AGENT_SERVICE_DB_PASSWORD ENDORSER_DB_PASSWORD PLATFORM_DB_PASSWORD CONSOLE_DB_PASSWORD \
           BIOMETRIC_DB_PASSWORD MEDIATOR_DB_PASSWORD PLATFORM_RO_PASSWORD MONITORING_DB_PASSWORD; do
  [ "${kind_of[$key]:-}" = generate ] || err "$key must be listed with kind generate (pg-roles.sh)"
done

if [ "$errors" -gt 0 ]; then
  echo "secrets.list: $errors problem(s)" >&2
  exit 1
fi
echo "secrets.list: ${#listed[@]} entries, ${#kind_of[@]} keys, matches the ${#mounted[@]} mounts of the compose files"
