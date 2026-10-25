#!/usr/bin/env bash
# One-time secrets for Phase 7 H2/H3 (runbooks/postgres-roles.md). Idempotent: keys that already
# exist are left alone. Values are generated here and never printed.
#
#   infra/scripts/phase7-secrets.sh
set -euo pipefail

ROOT="${ROOT:-/opt/12id}"
cd "$ROOT"
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$ROOT/secrets/age.key}"

dec() { sops --decrypt --input-type dotenv --output-type dotenv "infra/env/staging/secrets/$1.sops.env"; }
value() { dec "$1" | sed -n "s/^$2=//p"; }
has() { dec "$1" | grep -q "^$2="; }
gen() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-40; }
set_new() {
  if has "$1" "$2"; then echo "$1/$2: already set"
  else gen | infra/scripts/set-secret.sh "$1" "$2" >/dev/null; echo "$1/$2: set"; fi
}

set_new agent AGENT_SERVICE_DB_PASSWORD
set_new agent ENDORSER_DB_PASSWORD
set_new agent AGENT_ENDORSER_TOKEN
set_new platform PLATFORM_DB_PASSWORD
set_new console CONSOLE_DB_PASSWORD
set_new biometric BIOMETRIC_DB_PASSWORD
set_new mediator MEDIATOR_DB_PASSWORD
set_new monitoring MONITORING_DB_PASSWORD

# Same value in two files.
if ! has agent PLATFORM_AGENT_TOKEN; then
  t="$(gen)"
  # Trailing newline: set-secret.sh reads with `read`, which fails at EOF without one.
  printf '%s\n' "$t" | infra/scripts/set-secret.sh agent PLATFORM_AGENT_TOKEN >/dev/null
  printf '%s\n' "$t" | infra/scripts/set-secret.sh platform PLATFORM_AGENT_TOKEN >/dev/null
  unset t
  echo "agent+platform/PLATFORM_AGENT_TOKEN: set"
fi
# Trap 45: the VM's platform.sops.env lost CONSOLE_TOKEN; it must equal console.sops.env's.
if ! has platform CONSOLE_TOKEN; then
  value console CONSOLE_TOKEN | infra/scripts/set-secret.sh platform CONSOLE_TOKEN >/dev/null
  echo "platform/CONSOLE_TOKEN: copied from console"
fi

[ "$(value agent PLATFORM_AGENT_TOKEN)" = "$(value platform PLATFORM_AGENT_TOKEN)" ] || { echo "PLATFORM_AGENT_TOKEN differs between agent and platform" >&2; exit 1; }
[ "$(value console CONSOLE_TOKEN)" = "$(value platform CONSOLE_TOKEN)" ] || { echo "CONSOLE_TOKEN differs between console and platform" >&2; exit 1; }
[[ "$(value platform PLATFORM_RO_PASSWORD)" =~ ^[A-Za-z0-9]{24,}$ ]] || { echo "PLATFORM_RO_PASSWORD must be [A-Za-z0-9]{24,}; regenerate it" >&2; exit 1; }
echo "Phase 7 secrets ready."
