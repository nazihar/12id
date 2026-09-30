#!/usr/bin/env bash
# Prints one fresh single-use mediator invitation URL, for tools that need a mediated Credo holder
# (the ledger stack's smoke-credo, MEDIATOR_INVITATION_FILE for infra/smoke and the spikes).
#
#   MEDIATOR_INVITATION_URL="$(infra/scripts/mediator-invitation.sh)" \
#     infra/scripts/deploy.sh ledger run --rm smoke-credo
#
# Since the mediator's -p6 patch (Phase 7 review L6) there is no startup invitation in the logs any
# more; this calls the patched POST /admin/invitations on a replica's loopback port, as the platform
# API does. The token is decrypted into this process only and sent on stdin, never on a command line.
# An invitation nobody uses is deleted by the platform sweep after MEDIATOR_INVITATION_TTL_HOURS.
set -euo pipefail

ENV="${ENV:-staging}"
ROOT="${ROOT:-/opt/12id/infra/env/$ENV}"
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-/opt/12id/secrets/age.key}"
MEDIATOR_URL="${MEDIATOR_URL:-http://127.0.0.1:3001}"

token="$(sops --decrypt --input-type dotenv --output-type dotenv "$ROOT/secrets/mediator.sops.env" | sed -n 's/^MEDIATOR_ADMIN_TOKEN=//p')"
[ -n "$token" ] || { echo "MEDIATOR_ADMIN_TOKEN not found in mediator.sops.env" >&2; exit 1; }

response="$(printf 'x-admin-token: %s\n' "$token" | curl -fsS -X POST -H @- "$MEDIATOR_URL/admin/invitations")"
url="$(printf '%s' "$response" | sed -n 's/.*"invitationUrl":"\([^"]*\)".*/\1/p')"
[ -n "$url" ] || { echo "unexpected answer from $MEDIATOR_URL/admin/invitations" >&2; exit 1; }
printf '%s\n' "$url"
