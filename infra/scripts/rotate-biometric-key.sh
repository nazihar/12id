#!/usr/bin/env bash
# Rotates the biometric master key (Phase 9 W4, runbooks/key-rotation.md). The per-tenant data keys,
# and so every stored vendor configuration and reference image, stay the same; only their wrapping
# changes (services/biometric-service/src/rotate-master-key.ts, one transaction).
#
#   [ENV=staging] infra/scripts/rotate-biometric-key.sh
#
# 1. BIOMETRIC_MASTER_KEY_NEXT is generated into biometric.sops.env (kept if a failed run left one).
# 2. biometric-service stops: a check created mid-rotation would wrap with the old key. Gated
#    exchanges wait; platform-api answers biometric calls with 502 for the minute this takes.
# 3. The re-wrap runs as a one-shot of the service image, the next key on stdin (never a file, an
#    argument or an environment value).
# 4. Only after it succeeded: BIOMETRIC_MASTER_KEY takes the next key's value, the NEXT key is removed,
#    and the stack is redeployed (the secrets hash recreates the container with the new key).
# On a failed re-wrap nothing changed in the database: the service is started again on the old key.
# Take a backup first (backup-postgres.sh); the old key stays in that backup's sops file history.
set -euo pipefail

ENV="${ENV:-staging}"
ROOT="${ROOT:-/opt/12id}"
SCRIPTS="$ROOT/infra/scripts"
export ENV
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$ROOT/secrets/age.key}"
file="$ROOT/infra/env/$ENV/secrets/biometric.sops.env"

next_key() { sops --decrypt --input-type dotenv --output-type dotenv "$file" | sed -n 's/^BIOMETRIC_MASTER_KEY_NEXT=//p'; }

if [ -z "$(next_key)" ]; then
  "$SCRIPTS/set-secret.sh" biometric BIOMETRIC_MASTER_KEY_NEXT --generate-base64 > /dev/null
  echo "generated BIOMETRIC_MASTER_KEY_NEXT"
else
  echo "reusing the BIOMETRIC_MASTER_KEY_NEXT a previous run left"
fi

echo "stopping biometric-service"
"$SCRIPTS/deploy.sh" biometric stop biometric-service

if ! next_key | "$SCRIPTS/deploy.sh" biometric run --rm -T --no-deps biometric-service biometric-service/src/rotate-master-key.ts; then
  echo "re-wrap failed; starting biometric-service again on the current key" >&2
  "$SCRIPTS/deploy.sh" biometric up -d
  exit 1
fi

"$SCRIPTS/set-secret.sh" biometric BIOMETRIC_MASTER_KEY --from BIOMETRIC_MASTER_KEY_NEXT > /dev/null
"$SCRIPTS/set-secret.sh" biometric BIOMETRIC_MASTER_KEY_NEXT --unset > /dev/null
echo "BIOMETRIC_MASTER_KEY promoted; redeploying"
"$SCRIPTS/deploy.sh" biometric up -d

for _ in $(seq 1 30); do
  if curl -fsS -m 3 http://127.0.0.1:3430/healthz > /dev/null 2>&1; then
    echo "biometric-service healthy on the new master key"
    exit 0
  fi
  sleep 2
done
echo "biometric-service did not become healthy; check: deploy.sh biometric logs biometric-service" >&2
exit 1
