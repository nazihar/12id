#!/usr/bin/env bash
# Fails the deploy if the mediator's Drizzle migration did not actually create its schema.
#
# `drizzle:migrate:postgres` exits 0 with no output when --database-url is missing and
# creates nothing; the mediator then dies with `relation "StorageVersion" does not exist`
# (4-init §7.3). The migrate container's exit code therefore proves nothing.
#
# Tables checked, from `drizzle-storage --bundle core --bundle didcomm --bundle mediator`:
#   StorageVersion        Credo core bundle
#   PushNotificationsFcm  mediator bundle (apps/mediator/migrations/postgres/0000_initial.sql)
#
# The pickup-queue tables (queued_message, live_session) are created by the mediator itself
# at startup, not by this migration; pass --after-start to check those too.
set -euo pipefail

# Through deploy.sh: compose.mediator.yml requires POSTGRES_PASSWORD even for `exec`.
COMPOSE="${COMPOSE:-/opt/12id/infra/scripts/deploy.sh mediator}"
PGUSER="${PGUSER:-postgres}"
DRIZZLE_DB="${DRIZZLE_DB:-drizzle}"
PICKUP_DB="${PICKUP_DB:-message_pickup}"

missing=0

check() { # db table
  local exists
  exists="$($COMPOSE exec -T postgres psql -U "$PGUSER" -d "$1" -tAc "select to_regclass('public.\"$2\"') is not null")"
  if [ "$exists" = "t" ]; then
    echo "ok       $1.$2"
  else
    echo "MISSING  $1.$2"
    missing=1
  fi
}

check "$DRIZZLE_DB" StorageVersion
check "$DRIZZLE_DB" PushNotificationsFcm

if [ "${1:-}" = "--after-start" ]; then
  check "$PICKUP_DB" queued_message
  check "$PICKUP_DB" live_session
fi

if [ "$missing" -ne 0 ]; then
  echo "mediator schema incomplete - did the migration run with --database-url?" >&2
  exit 1
fi
