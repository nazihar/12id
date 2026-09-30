#!/usr/bin/env bash
# Builds and pushes every 12id image, and writes the release bundle's release.env (Phase 9 W2, M17).
# By hand until W3's CI runs the same two steps on GitHub Actions.
#
#   infra/scripts/release.sh build              build HEAD once, push :sha-<short>, write release.env
#   infra/scripts/release.sh tag 1.2.3          add :1.2.3 to the digests in release.env (no rebuild)
#
# REGISTRY (default ghcr.io/nazihar) must be logged in (`docker login ghcr.io`, a token with
# write:packages). A dirty tree is refused unless ALLOW_DIRTY=1 (rehearsals); its version gets -dirty.
# RELEASE_FILE (default infra/compose/release.env) is what deploy.sh reads: one VERSION for every image
# and one digest per image, so a deploy pulls exactly what was built and a rollback is the previous file.
set -euo pipefail

cmd="${1:?usage: release.sh build | tag X.Y.Z}"
# Outside a git checkout (a copied tree), VERSION and REVISION must be given.
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))"
REGISTRY="${REGISTRY:-ghcr.io/nazihar}"
RELEASE_FILE="${RELEASE_FILE:-$repo/infra/compose/release.env}"
BUILD_FILE="$repo/infra/build/compose.build.yml"
IMAGES=(services console console-tools mediator mediator-migrate caddy vdr-proxy ledger-tools ledger-ceremony)

digest_var() { printf '%s_DIGEST' "$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; }

write_release() { # version revision; digests in the associative array `digests`
  {
    echo "# The release bundle's image pins (Phase 9 W2): written by infra/scripts/release.sh, read by deploy.sh."
    echo "# Revision $2, $(date -u +%Y-%m-%dT%H:%M:%SZ). Roll back by deploying the previous version of this file."
    echo "REGISTRY=$REGISTRY"
    echo "VERSION=$1"
    for name in "${IMAGES[@]}"; do
      echo "$(digest_var "$name")=${digests[$name]}"
    done
  } > "$RELEASE_FILE"
  echo "wrote $RELEASE_FILE"
}

declare -A digests

case "$cmd" in
  build)
    if [ -n "${VERSION:-}" ] && [ -n "${REVISION:-}" ]; then
      version="$VERSION"
      revision="$REVISION"
    else
      revision="$(git -C "$repo" rev-parse HEAD)"
      version="sha-$(git -C "$repo" rev-parse --short=7 HEAD)"
    fi
    if [ -d "$repo/.git" ] && [ -n "$(git -C "$repo" status --porcelain)" ]; then
      [ "${ALLOW_DIRTY:-}" = 1 ] || { echo "the tree has uncommitted changes; commit first (or ALLOW_DIRTY=1 for a rehearsal)" >&2; exit 1; }
      version="$version-dirty"
      revision="$revision-dirty"
    fi
    export REGISTRY VERSION="$version" REVISION="$revision"
    docker compose -f "$BUILD_FILE" build
    docker compose -f "$BUILD_FILE" push
    for name in "${IMAGES[@]}"; do
      ref="$REGISTRY/12id-$name:$version"
      # The registry's digest of what was pushed (the index, when the build adds attestations).
      digest="$(docker buildx imagetools inspect "$ref" | sed -n 's/^Digest: *\(sha256:[0-9a-f]*\)$/\1/p' | head -1)"
      [ -n "$digest" ] || { echo "no digest for $ref" >&2; exit 1; }
      digests[$name]="$digest"
    done
    write_release "$version" "$revision"
    ;;
  tag)
    new="${2:?usage: release.sh tag X.Y.Z}"
    [[ "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like 1.2.3" >&2; exit 2; }
    # shellcheck disable=SC1090
    source "$RELEASE_FILE"
    for name in "${IMAGES[@]}"; do
      var="$(digest_var "$name")"
      digest="${!var:?$var missing from $RELEASE_FILE}"
      docker buildx imagetools create --tag "$REGISTRY/12id-$name:$new" "$REGISTRY/12id-$name@$digest"
      digests[$name]="$digest"
    done
    write_release "$new" "tag v$new of $VERSION"
    ;;
  *)
    echo "usage: release.sh build | tag X.Y.Z" >&2
    exit 2
    ;;
esac
