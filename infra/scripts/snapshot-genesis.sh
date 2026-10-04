#!/usr/bin/env bash
# Publishes a versioned, immutable genesis snapshot for https://genesis.<domain>/ (W2).
#
#   snapshot-genesis.sh <version>        e.g. snapshot-genesis.sh v1
#   GENESIS_SOURCE=/opt/12id/ceremony/out/pool_transactions_genesis snapshot-genesis.sh v1
#
# The source is von-network's /genesis (staging) unless GENESIS_SOURCE names a file: our own
# network's genesis comes from the ceremony (Phase 9 W2, runbooks/ledger-ceremony.md).
#
# Layout under $GENESIS_ROOT (served read-only by Caddy):
#   v1/pool_transactions_genesis          immutable; never overwritten
#   v1/pool_transactions_genesis.sha256
#   v1/pool_transactions_genesis.minisig  only when $MINISIGN_KEY is set (W9)
#   current/                               copy of the newest version, short cache
#
# Genesis is baked into agents and cached by the SDK, so a published version must never
# change. Rotating validators means a new version (runbooks/genesis-rotation.md).
set -euo pipefail

VERSION="${1:?usage: snapshot-genesis.sh <version, e.g. v1>}"
[[ "$VERSION" =~ ^v[0-9]+$ ]] || { echo "version must look like v1, v2, ..." >&2; exit 2; }

LEDGER_URL="${LEDGER_URL:-http://127.0.0.1:9000}"
# Outside the code tree since Phase 9 W2, so a tree sync never touches a published version.
GENESIS_ROOT="${GENESIS_ROOT:-/opt/12id/genesis}"
EXPECTED_NODES="${EXPECTED_NODES:-4}"
FILE=pool_transactions_genesis

target="$GENESIS_ROOT/$VERSION"
if [ -e "$target" ]; then
  echo "$target already exists; published versions are immutable" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [ -n "${GENESIS_SOURCE:-}" ]; then
  cp "$GENESIS_SOURCE" "$tmp/$FILE"
else
  curl -fsS "$LEDGER_URL/genesis" -o "$tmp/$FILE"
fi

# One JSON transaction per line; each validator is a NODE txn (type "0").
nodes="$(grep -c '"type":"0"' "$tmp/$FILE" || true)"
if [ "$nodes" -ne "$EXPECTED_NODES" ]; then
  echo "expected $EXPECTED_NODES validator txns, found $nodes - is the pool up?" >&2
  exit 1
fi

# Phones connect to client_ip, so it must be public. node_ip carries validator-to-validator traffic:
# our own network keeps it on a private Docker network on purpose (compose.ledger-nodes.yml), while
# von-network advertises the public IP there too. ALLOW_PRIVATE_CLIENT_IP=1 only for a local rehearsal.
if [ "${ALLOW_PRIVATE_CLIENT_IP:-}" != 1 ] && grep -Eq '"client_ip":"(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|host\.docker\.internal)' "$tmp/$FILE"; then
  echo "genesis advertises a private client address - phones could not reach the ledger" >&2
  exit 1
fi

(cd "$tmp" && sha256sum "$FILE" > "$FILE.sha256")

if [ -n "${MINISIGN_KEY:-}" ]; then
  minisign -S -s "$MINISIGN_KEY" -m "$tmp/$FILE" -t "12id genesis $VERSION $(date -u +%Y-%m-%dT%H:%M:%SZ)"
else
  echo "warning: MINISIGN_KEY not set; publishing without a signature" >&2
fi

# World-readable whatever the caller's umask: the non-root vdr-proxy mounts it (Phase 9 W4: a v2 published
# under umask 077 was 0700 and vdr-proxy crash-looped on "Permission denied").
mkdir -p "$target"
chmod 0755 "$target"
cp "$tmp"/"$FILE"* "$target/"
chmod 0444 "$target"/*

rm -rf "$GENESIS_ROOT/current.tmp"
cp -r "$target" "$GENESIS_ROOT/current.tmp"
chmod u+w "$GENESIS_ROOT/current.tmp" "$GENESIS_ROOT/current.tmp"/*
chmod 0755 "$GENESIS_ROOT/current.tmp"
chmod 0644 "$GENESIS_ROOT/current.tmp"/*
rm -rf "$GENESIS_ROOT/current"
mv "$GENESIS_ROOT/current.tmp" "$GENESIS_ROOT/current"

echo "published $VERSION: $nodes validators, sha256 $(cut -d' ' -f1 "$target/$FILE.sha256")"
