#!/usr/bin/env bash
# Per-service Postgres roles (Phase 7 H3). Idempotent: run it after any restore, after a fresh
# provision, or whenever a password changes. It never drops anything.
#
#   infra/scripts/pg-roles.sh agent       # agent-postgres
#   infra/scripts/pg-roles.sh mediator    # the mediator stack's postgres
#   infra/scripts/pg-roles.sh all
#
# For each service role: LOGIN, not superuser, cannot create databases or roles; it owns its own
# databases and every schema, table, view, sequence, type and function in them. PUBLIC loses
# CONNECT on every managed database, so a role reaches only what it is granted here.
#
# Runs as the superuser inside the Postgres container (docker exec, stdin only: no password ever
# appears in a process list). Passwords come from the SOPS files, decrypted to /dev/shm.
set -euo pipefail

TARGET="${1:?usage: pg-roles.sh <agent|mediator|all>}"
ROOT="${ROOT:-/opt/12id/infra/staging}"
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-/opt/12id/secrets/age.key}"
AGENT_PG_CONTAINER="${AGENT_PG_CONTAINER:-agent-agent-postgres-1}"
MEDIATOR_PG_CONTAINER="${MEDIATOR_PG_CONTAINER:-mediator-postgres-1}"

dec="$(mktemp -p "${SECRETS_TMP:-/dev/shm}" 12id-pg-roles.XXXXXX)"
trap 'shred -u "$dec" 2>/dev/null || rm -f "$dec"' EXIT
chmod 600 "$dec"
for stack in agent mediator platform console biometric monitoring; do
  f="$ROOT/secrets/$stack.sops.env"
  [ -f "$f" ] || { echo "missing $f" >&2; exit 2; }
  sops --decrypt --input-type dotenv --output-type dotenv "$f" >> "$dec"
done
# Read only the keys this script needs: other values (MAIL_FROM, SMTP_URL) are not valid shell.
for key in AGENT_SERVICE_DB_PASSWORD ENDORSER_DB_PASSWORD PLATFORM_DB_PASSWORD CONSOLE_DB_PASSWORD \
           BIOMETRIC_DB_PASSWORD MEDIATOR_DB_PASSWORD PLATFORM_RO_PASSWORD MONITORING_DB_PASSWORD; do
  printf -v "$key" '%s' "$(sed -n "s/^$key=//p" "$dec" | tail -1)"
done

# Passwords are generated as [A-Za-z0-9] (runbook); refusing anything else keeps the quoting below safe.
need() {
  local name="$1" value="${!1:-}"
  [ -n "$value" ] || { echo "secret $name is not set (infra/runbooks/postgres-roles.md)" >&2; exit 2; }
  [[ "$value" =~ ^[A-Za-z0-9]{24,}$ ]] || { echo "secret $name must be 24+ characters of [A-Za-z0-9]" >&2; exit 2; }
}

psql_in() { docker exec -i "$1" psql -v ON_ERROR_STOP=1 -q -U postgres -d "${2:-postgres}"; }

# role <container> <role> <password variable>
role() {
  need "$3"
  psql_in "$1" <<SQL
SELECT format('CREATE ROLE %I LOGIN', '$2') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$2') \gexec
ALTER ROLE "$2" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${!3}';
SQL
}

# database <container> <db> <owner>: create if missing, owner, no PUBLIC access, owner takes every object.
database() {
  psql_in "$1" <<SQL
SELECT format('CREATE DATABASE %I OWNER %I', '$2', '$3') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$2') \gexec
ALTER DATABASE "$2" OWNER TO "$3";
REVOKE ALL ON DATABASE "$2" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE "$2" TO "$3";
SQL
  # REASSIGN OWNED BY postgres is refused for the bootstrap superuser, hence the loop. Sequences
  # linked to a column follow their table and cannot be altered alone.
  psql_in "$1" "$2" <<SQL
SET pgroles.owner = '$3';
DO \$\$
DECLARE
  target text := current_setting('pgroles.owner');
  r record;
BEGIN
  FOR r IN SELECT nspname FROM pg_namespace
           WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
             AND pg_get_userbyid(nspowner) <> target LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', r.nspname, target);
  END LOOP;
  FOR r IN SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
             AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND pg_get_userbyid(c.relowner) <> target LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO %I',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.nspname, r.relname, target);
  END LOOP;
  FOR r IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind = 'S' AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
             AND pg_get_userbyid(c.relowner) <> target
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')) LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO %I', r.nspname, r.relname, target);
  END LOOP;
  FOR r IN SELECT n.nspname, t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE t.typtype IN ('e', 'd', 'r', 'm') AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
             AND pg_get_userbyid(t.typowner) <> target LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO %I', r.nspname, r.typname, target);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
             AND p.prokind IN ('f', 'p', 'a') AND pg_get_userbyid(p.proowner) <> target
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE r.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END, r.sig, target);
  END LOOP;
END
\$\$;
SQL
}

# monitor <container> <db> <table...>: the exporters' read-only role (pg_monitor + SELECT on the
# tables their custom queries read, monitoring/postgres-exporter*-queries.yml).
monitor() {
  local container="$1" db="$2"; shift 2
  local grants=""
  for table in "$@"; do grants+="GRANT SELECT ON TABLE \"$table\" TO monitoring_ro;"$'\n'; done
  psql_in "$container" <<SQL
SET client_min_messages = warning;
GRANT pg_monitor TO monitoring_ro;
GRANT CONNECT ON DATABASE "$db" TO monitoring_ro;
SQL
  psql_in "$container" "$db" <<SQL
GRANT USAGE ON SCHEMA public TO monitoring_ro;
$grants
SQL
}

agent() {
  local c="$AGENT_PG_CONTAINER"
  role "$c" agent_service AGENT_SERVICE_DB_PASSWORD
  role "$c" endorser_service ENDORSER_DB_PASSWORD
  role "$c" platform_api PLATFORM_DB_PASSWORD
  role "$c" console CONSOLE_DB_PASSWORD
  role "$c" biometric BIOMETRIC_DB_PASSWORD
  role "$c" monitoring_ro MONITORING_DB_PASSWORD
  database "$c" agent_root agent_service       # Askar root store (tenant wallets)
  database "$c" agent_service agent_service
  database "$c" endorser endorser_service      # Askar endorser store (the endorser DID key)
  database "$c" endorser_service endorser_service
  database "$c" platform_api platform_api
  database "$c" console console
  database "$c" biometric biometric
  monitor "$c" platform_api exchange_gate_events exchange_gates webhook_deliveries wallets idempotency_keys
  monitor "$c" agent_service outbox tenants          # review M16: outbox lag
  monitor "$c" endorser_service endorsement_audit    # review M16: refusals and ledger-write pressure
  echo "agent-postgres: roles and ownership applied"
}

mediator() {
  local c="$MEDIATOR_PG_CONTAINER"
  role "$c" mediator MEDIATOR_DB_PASSWORD
  role "$c" platform_ro PLATFORM_RO_PASSWORD
  role "$c" monitoring_ro MONITORING_DB_PASSWORD
  database "$c" drizzle mediator
  database "$c" message_pickup mediator
  database "$c" mediator mediator              # mediator Askar KMS store
  # platform-api maps mediator webhooks to wallets (Phase 3 P9); nothing else.
  psql_in "$c" <<SQL
GRANT CONNECT ON DATABASE drizzle TO platform_ro;
SQL
  psql_in "$c" drizzle <<SQL
GRANT USAGE ON SCHEMA public TO platform_ro;
GRANT SELECT ("id", "out_of_band_id", "thread_id") ON "DidcommConnection" TO platform_ro;
SQL
  monitor "$c" message_pickup queued_message live_session
  monitor "$c" drizzle DidcommMediation DidcommOutOfBand DidcommConnection  # review M16: record growth
  # The endorser store moved to agent-postgres (H3). Until the old copy is dropped, nobody but the
  # superuser may open it.
  psql_in "$c" <<SQL
SELECT 'REVOKE ALL ON DATABASE endorser FROM PUBLIC' WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = 'endorser') \gexec
SQL
  echo "mediator postgres: roles and ownership applied"
}

# askar_schema <container> <db> <role>: Askar keeps its tables in the schema named after the user
# that provisioned the store and finds them through search_path ("$user", public). Stores created
# as `postgres` sit in schema `postgres`, invisible to the new role. Renaming the schema to the role
# makes the store look as if the role had provisioned it. Run it at the cutover only, with the
# store's consumers stopped: the old containers still connect as `postgres` and need the old name.
askar_schema() {
  psql_in "$1" "$2" <<SQL
SELECT format('ALTER SCHEMA postgres RENAME TO %I', '$3')
 WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'postgres')
   AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '$3') \gexec
SQL
  echo "$2: Askar schema is now $(docker exec "$1" psql -U postgres -d "$2" -tAc "SELECT string_agg(nspname, ',') FROM pg_namespace WHERE nspname IN ('postgres', '$3')")"
}

case "$TARGET" in
  agent) agent ;;
  mediator) mediator ;;
  all) mediator; agent ;;
  # Cutover of existing staging stores (runbooks/postgres-roles.md); fresh installs do not need it.
  askar-schema-agent)
    askar_schema "$AGENT_PG_CONTAINER" agent_root agent_service
    askar_schema "$AGENT_PG_CONTAINER" endorser endorser_service ;;
  askar-schema-mediator)
    askar_schema "$MEDIATOR_PG_CONTAINER" mediator mediator ;;
  *) echo "usage: pg-roles.sh <agent|mediator|all|askar-schema-agent|askar-schema-mediator>" >&2; exit 2 ;;
esac
