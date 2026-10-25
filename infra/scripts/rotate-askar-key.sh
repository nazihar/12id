#!/usr/bin/env bash
# Rotates one Askar store key (Phase 9 W4, runbooks/key-rotation.md):
#
#   [ENV=staging] infra/scripts/rotate-askar-key.sh agent|endorser|mediator
#
#   agent     the root store agent_root (every tenant profile): AGENT_ASKAR_STORE_KEY (agent.sops.env)
#   endorser  the endorser's store: ENDORSER_ASKAR_STORE_KEY (ledger.sops.env; the ledger stack's
#             bootstrap-endorser reads the same key)
#   mediator  the mediator's key store `mediator`: MEDIATOR_ASKAR_STORE_KEY (mediator.sops.env)
#
# 1. <KEY>_NEXT is generated into the sops file (kept if a failed run left one).
# 2. The store's users stop. agent: agent-service, so DIDComm and the internal API are down; endorser:
#    endorser-service, so ledger writes wait; mediator: both replicas, so every wallet's polls fail
#    until they are back (about a minute; the queue is in Postgres and survives).
# 3. credo-base/src/askar-rekey.ts runs as a one-shot with the store's usual configuration, the next
#    key on stdin. It proves the result: the next key opens the store, the current one no longer does.
# 4. Only after it succeeded: <KEY> takes the next key's value, <KEY>_NEXT is removed, the stack is
#    redeployed. On a failure the store is unchanged and the services start again on the current key.
# Take a backup first (backup-postgres.sh): an Askar database dump is only readable with the key that
# was current when it was taken, so keep the old key with the backups it opens (the sops history).
set -euo pipefail

ENV="${ENV:-staging}"
ROOT="${ROOT:-/opt/12id}"
SCRIPTS="$ROOT/infra/scripts"
export ENV
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$ROOT/secrets/age.key}"

case "${1:-}" in
  agent) stack=agent; secrets=agent; key=AGENT_ASKAR_STORE_KEY; users=(agent-service); runner=(agent-service credo-base/src/askar-rekey.ts) ;;
  endorser) stack=agent; secrets=ledger; key=ENDORSER_ASKAR_STORE_KEY; users=(endorser-service); runner=(endorser-service credo-base/src/askar-rekey.ts) ;;
  mediator) stack=mediator; secrets=mediator; key=MEDIATOR_ASKAR_STORE_KEY; users=(mediator-1 mediator-2); runner=(askar-rekey) ;;
  *) echo "usage: [ENV=staging|production] rotate-askar-key.sh agent|endorser|mediator" >&2; exit 1 ;;
esac
file="$ROOT/infra/env/$ENV/secrets/$secrets.sops.env"

next_key() { sops --decrypt --input-type dotenv --output-type dotenv "$file" | sed -n "s/^${key}_NEXT=//p"; }

if [ -z "$(next_key)" ]; then
  "$SCRIPTS/set-secret.sh" "$secrets" "${key}_NEXT" --generate > /dev/null
  echo "generated ${key}_NEXT"
else
  echo "reusing the ${key}_NEXT a previous run left"
fi

echo "stopping ${users[*]}"
"$SCRIPTS/deploy.sh" "$stack" stop "${users[@]}"

# `run` starts a service that has a profile (the mediator's askar-rekey) when it names it.
if ! next_key | "$SCRIPTS/deploy.sh" "$stack" run --rm -T --no-deps "${runner[@]}"; then
  echo "rekey failed; starting ${users[*]} again on the current key" >&2
  "$SCRIPTS/deploy.sh" "$stack" up -d
  exit 1
fi

"$SCRIPTS/set-secret.sh" "$secrets" "$key" --from "${key}_NEXT" > /dev/null
"$SCRIPTS/set-secret.sh" "$secrets" "${key}_NEXT" --unset > /dev/null
echo "$key promoted; redeploying $stack"
"$SCRIPTS/deploy.sh" "$stack" up -d
echo "done. Check health: ENV=$ENV $SCRIPTS/deploy.sh $stack ps"
