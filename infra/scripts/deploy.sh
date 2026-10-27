#!/usr/bin/env bash
# Runs docker compose for one stack of one environment (Phase 9 W2).
#
#   ENV=staging deploy.sh <stack> [compose args...]     default args: up -d
#   deploy.sh mediator
#   deploy.sh mediator logs -f mediator-1
#
# What it puts together:
#   $INFRA/compose/compose.<stack>.yml          the release bundle's stack (one set for every environment)
#   $INFRA/env/$ENV/compose.<stack>.yml         the environment's overlay, if there is one (staging only)
#   $INFRA/env/$ENV.env                         the environment's non-secret settings (hostnames, ledger)
#   $RELEASE_FILE (default compose/release.env) which images: REGISTRY, VERSION and one digest per image
#   $INFRA/env/$ENV/secrets/*.sops.env          the secrets, decrypted with the VM's age key
#
# Secrets (review M11): every secret a compose file mounts (`file: ${RUN_SECRETS}/<stack>/<KEY>`) is
# decrypted into $RUN_SECRETS/<stack>/<KEY>: directory root 0700, file root:$SECRETS_GID 0440, written
# with sudo. Containers mount them under /run/secrets and read NAME_FILE, so no value is in the
# container configuration (`docker inspect`) or on Compose's command line, and after a reboot Docker
# restarts every container unattended from the files on disk (owner decision, 18-phase-9 M11). Only
# the keys a compose file references are written; a referenced key missing from SOPS becomes an empty
# file (an optional secret; a service that requires it refuses to start and names it).
# SECRETS_REV, a hash of the stack's secrets, labels the containers so `up -d` recreates them when one
# changes (Compose does not notice changed files).
set -euo pipefail

STACK="${1:?usage: [ENV=staging|production] deploy.sh <stack> [compose args]}"
shift

ENV="${ENV:-staging}"
INFRA="${INFRA:-/opt/12id/infra}"
BUNDLE="${BUNDLE:-$INFRA/compose}"
ENV_FILE="$INFRA/env/$ENV.env"
export ENV_DIR="$INFRA/env/$ENV"
RELEASE_FILE="${RELEASE_FILE:-$BUNDLE/release.env}"
export RUN_SECRETS="${RUN_SECRETS:-/opt/12id/run-secrets}"
export SECRETS_GID="${SECRETS_GID:-12000}"
export GENESIS_DIR="${GENESIS_DIR:-/opt/12id/genesis}"
export METRICS_DIR="${METRICS_DIR:-/opt/12id/metrics}"
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-/opt/12id/secrets/age.key}"

compose="$BUNDLE/compose.$STACK.yml"
[ -f "$compose" ] || { echo "no such stack: $compose" >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "no environment file: $ENV_FILE" >&2; exit 2; }
[ -f "$RELEASE_FILE" ] || { echo "no release file: $RELEASE_FILE" >&2; exit 2; }
[ -z "${EXTRA_SECRETS:-}" ] || echo "note: EXTRA_SECRETS is no longer needed and is ignored (Phase 9 W2)" >&2

files=(-f "$compose")
[ -f "$ENV_DIR/compose.$STACK.yml" ] && files+=(-f "$ENV_DIR/compose.$STACK.yml")

# <stack>/<KEY> pairs this stack mounts, from the base file and the overlay.
referenced() {
  local f
  # `if`, not `&&`: under pipefail a missing overlay must not fail the whole function.
  for f in "$compose" "$ENV_DIR/compose.$STACK.yml"; do
    if [ -f "$f" ]; then
      grep -oE '\$\{RUN_SECRETS[^}]*\}/[a-z0-9-]+/[A-Z][A-Z0-9_]*' "$f" | sed 's#^[^}]*}/##' || true
    fi
  done | sort -u
}

decrypted_dir=""
cleanup() { if [ -n "$decrypted_dir" ]; then rm -rf "$decrypted_dir"; fi; }
trap cleanup EXIT

# Decrypts each needed SOPS file once, into tmpfs, and prints "<stack>/<KEY>" = value lookups via files.
sync_secrets() {
  local refs pair stack key src value tmp
  refs="$(referenced)"
  [ -n "$refs" ] || { SECRETS_REV=none; export SECRETS_REV; return; }

  decrypted_dir="$(mktemp -d -p /dev/shm "12id-$STACK.XXXXXX")"
  chmod 700 "$decrypted_dir"
  for stack in $(printf '%s\n' "$refs" | cut -d/ -f1 | sort -u); do
    src="$ENV_DIR/secrets/$stack.sops.env"
    if [ -f "$src" ]; then
      sops --decrypt --input-type dotenv --output-type dotenv "$src" > "$decrypted_dir/$stack.env"
    else
      : > "$decrypted_dir/$stack.env"
    fi
  done

  sudo install -d -o root -g root -m 0700 "$RUN_SECRETS"
  local hash_input="$decrypted_dir/rev"
  : > "$hash_input"
  for pair in $refs; do
    stack="${pair%%/*}"
    key="${pair#*/}"
    # Last assignment wins, as with --env-file. Values are written without a trailing newline.
    value="$(sed -n "s/^$key=//p" "$decrypted_dir/$stack.env" | tail -1)"
    [ -n "$value" ] || echo "note: $pair is not set in $stack.sops.env; mounting an empty file" >&2
    tmp="$decrypted_dir/value"
    printf '%s' "$value" > "$tmp"
    printf '%s=' "$pair" >> "$hash_input"
    sha256sum < "$tmp" >> "$hash_input"
    sudo install -d -o root -g root -m 0700 "$RUN_SECRETS/$stack"
    # Rewrite only when the value changed: an unchanged file keeps its inode under running containers.
    if ! sudo cmp -s "$tmp" "$RUN_SECRETS/$pair" 2>/dev/null; then
      sudo install -o root -g "$SECRETS_GID" -m 0440 "$tmp" "$RUN_SECRETS/$pair"
    fi
    shred -u "$tmp" 2>/dev/null || rm -f "$tmp"
  done
  SECRETS_REV="$(sha256sum < "$hash_input" | cut -c1-16)"
  export SECRETS_REV
}

[ $# -gt 0 ] || set -- up -d

# Only commands that create or start containers need the files; `ps`, `logs`, `exec`, `down` do not.
case "$1" in
  up|run|create|start|restart) sync_secrets ;;
  *) export SECRETS_REV="${SECRETS_REV:-unchanged}" ;;
esac

mkdir -p "$METRICS_DIR"
# Who owns the metrics directory: one-off jobs that write into it (the ledger write probe) run as that user, so
# the image's own user id need not match the host's deploy user (implement/29: uid 1000 only on staging).
METRICS_UID="$(stat -c %u "$METRICS_DIR")"
METRICS_GID="$(stat -c %g "$METRICS_DIR")"
export METRICS_UID METRICS_GID

docker compose --project-directory "$BUNDLE" "${files[@]}" \
  --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" "$@"
