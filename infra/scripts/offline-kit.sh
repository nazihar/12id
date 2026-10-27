#!/usr/bin/env bash
# The offline kit (implement/28 Q3): one release for a host without internet, signed by 12iD.
#
#   offline-kit.sh build --release-env release-X.Y.Z.env --bundle 12id-bundle-X.Y.Z.tar.gz \
#                        [--maven DIR] [--sign-key KEY] --out DIR                      (12iD's side)
#   offline-kit.sh verify DIR --pub 12id-release.pub                                   (the customer's side)
#   offline-kit.sh load DIR [--registry HOST[/PREFIX]] [--release-env-out FILE]        (the customer's host)
#
# The images live in the kit as a registry's storage directory (registry/), filled registry to registry with
# `skopeo copy --all --preserve-digests`. That keeps every manifest byte for byte, whatever its format, so the
# digests in release.env stay 12iD's: what runs is provably the release (an OCI layout would have to convert
# Docker-format manifest lists, which changes their digests).
#
# build   runs where the release's images can be pulled (a GHCR read login: skopeo uses AUTH_FILE, default
#         ~/.docker/config.json, which needs plain `auths`, not a credential helper). Every image of
#         release.env, ours and the third-party ones, all platforms; the registry and skopeo images (docker
#         save, for `load`); static linux-amd64 sops, age and minisign; the bundle, release.env and the Maven
#         part. SHA256SUMS over everything, signed with 12iD's release minisign key (--sign-key, the owner's,
#         kept offline; it asks for its password).
# verify  the signature with 12iD's release public key, received separately from the kit, then every sum.
# load    the sums again; installs sops, age and minisign from the kit when the host has none; loads the two
#         tool images; then either
#           - no --registry: a local registry on 127.0.0.1:5000 (container 12id-registry, volume 12id-registry,
#             restart always) holding the kit's storage. Docker pulls from 127.0.0.1 over plain HTTP by default;
#           - --registry: pushes every image into the organisation's registry (Harbor, Nexus); log in first
#             (docker login) and keep AUTH_FILE plain as above.
#         It writes release.env (default /opt/12id/infra/compose/release.env) with REGISTRY and every *_IMAGE
#         prefix pointing there. The digests do not change.
set -euo pipefail

REGISTRY_IMAGE=registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373
SKOPEO_IMAGE=quay.io/skopeo/stable:v1.16.1@sha256:94f5c5e26997e2e78c234ec9abf19a391c234b39eb22e6d1210d0b527c97dcc8
# The names the two tool images carry inside the kit. An image saved by digest alone cannot be found by that
# digest after `docker load` (the classic image store keeps no repository digest), and Docker would then
# fetch it from the internet; a tag survives the save and load.
KIT_REGISTRY_IMAGE=12id-kit/registry:2.8.3
KIT_SKOPEO_IMAGE=12id-kit/skopeo:v1.16.1
# Where `load` serves the images without --registry.
LOCAL_PORT="${LOCAL_PORT:-5000}"
# Static linux-amd64 tools for the host (sops's sum matches its published checksums file).
SOPS_URL=https://github.com/getsops/sops/releases/download/v3.9.4/sops-v3.9.4.linux.amd64
SOPS_SHA256=5488e32bc471de7982ad895dd054bbab3ab91c417a118426134551e9626e4e85
AGE_URL=https://github.com/FiloSottile/age/releases/download/v1.2.1/age-v1.2.1-linux-amd64.tar.gz
AGE_SHA256=7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50
MINISIGN_URL=https://github.com/jedisct1/minisign/releases/download/0.11/minisign-0.11-linux.tar.gz
MINISIGN_SHA256=f0a0954413df8531befed169e447a66da6868d79052ed7e892e50a4291af7ae0
AUTH_FILE="${AUTH_FILE:-$HOME/.docker/config.json}"
# Rehearsals only: a --registry target without TLS.
TARGET_TLS_VERIFY="${TARGET_TLS_VERIFY:-true}"
BUILD_PORT=5099
PUSH_PORT=5098

die() { printf 'offline-kit: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

# images <release.env>: one line per image: "<VAR> <source repo@digest> <path> <tag> <digest>".
# Ours: REGISTRY/12id-<name>:VERSION@<NAME>_DIGEST. Third-party: NAME_IMAGE=repo[:tag]@digest; the path is the
# repository without its registry host (docker.io/library/postgres and postgres are both "postgres").
images() {
  local registry version line var value name ref digest repo tag first
  registry="$(sed -n 's/^REGISTRY=//p' "$1")"
  version="$(sed -n 's/^VERSION=//p' "$1")"
  while IFS= read -r line; do
    var="${line%%=*}"; value="${line#*=}"
    case "$var" in
      *_DIGEST)
        name="$(printf '%s' "${var%_DIGEST}" | tr 'A-Z_' 'a-z-')"
        [ -n "$registry" ] && [ -n "$version" ] || die "$1: REGISTRY and VERSION are required with *_DIGEST lines"
        printf '%s %s %s %s %s\n' "$var" "$registry/12id-$name@$value" "12id-$name" "$version" "$value" ;;
      *_IMAGE)
        ref="${value%@*}"; digest="${value#*@}"
        [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "$var is not pinned by digest"
        tag=latest; repo="$ref"
        if [[ "${ref##*/}" == *:* ]]; then tag="${ref##*:}"; repo="${ref%:*}"; fi
        first="${repo%%/*}"
        if [ "$first" != "$repo" ] && { [[ "$first" == *.* ]] || [[ "$first" == *:* ]] || [ "$first" = localhost ]; }; then
          repo_path="${repo#*/}"
        else
          repo_path="$repo"
        fi
        [ "${repo_path%%/*}" != library ] || repo_path="${repo_path#library/}"
        printf '%s %s %s %s %s\n' "$var" "$repo@$digest" "$repo_path" "$tag" "$digest" ;;
    esac
  done < <(grep -E '^[A-Z][A-Z0-9_]*_(DIGEST|IMAGE)=' "$1")
}

skopeo() { # skopeo in its container, host network, with the registry login when there is one
  local auth=()
  [ -f "$AUTH_FILE" ] && auth=(-v "$AUTH_FILE:/auth.json:ro" -e REGISTRY_AUTH_FILE=/auth.json)
  docker run --rm --network host "${auth[@]}" "$SKOPEO_IMAGE" "$@"
}

# A registry on 127.0.0.1:<port> serving <dir>, as the caller's user (the files stay the caller's).
start_registry() { # name port dir [ro]
  docker rm -f "$1" > /dev/null 2>&1 || true
  docker run -d --name "$1" --user "$(id -u):$(id -g)" -p "127.0.0.1:$2:5000" \
    -v "$3:/var/lib/registry${4:+:ro}" "$REGISTRY_IMAGE" > /dev/null
  local n=0
  until curl -fsS -o /dev/null "http://127.0.0.1:$2/v2/" 2> /dev/null; do
    n=$((n + 1)); [ "$n" -lt 30 ] || die "the registry on 127.0.0.1:$2 does not start (docker logs $1)"
    sleep 1
  done
}

# check_digest <registry> <path> <digest> [--tls-verify=false]: the manifest there hashes to the digest.
check_digest() {
  local got
  got="$(skopeo inspect --raw ${4:-} "docker://$1/$2@$3" | sha256sum | cut -c1-64)"
  [ "sha256:$got" = "$3" ] || die "$1/$2@$3 has another manifest (sha256:$got)"
}

cmd_build() {
  local env="" bundle="" maven="" key="" out="" version
  while [ $# -gt 0 ]; do
    case "$1" in
      --release-env) env="${2:?}"; shift 2 ;;
      --bundle) bundle="${2:?}"; shift 2 ;;
      --maven) maven="${2:?}"; shift 2 ;;
      --sign-key) key="${2:?}"; shift 2 ;;
      --out) out="${2:?}"; shift 2 ;;
      *) die "build: unknown option $1" ;;
    esac
  done
  [ -f "$env" ] && [ -n "$out" ] || die "build needs --release-env FILE and --out DIR"
  [ -z "$bundle" ] || [ -f "$bundle" ] || die "--bundle $bundle: no such file"
  [ ! -e "$out" ] || die "$out exists; a kit is built into a new directory"
  version="$(sed -n 's/^VERSION=//p' "$env")"; version="${version:-third-party}"
  mkdir -p "$out/registry" "$out/tools" "$out/bin"
  out="$(cd "$out" && pwd)"

  say "images into $out/registry (all platforms, digests preserved)"
  docker pull -q "$REGISTRY_IMAGE" > /dev/null
  docker pull -q "$SKOPEO_IMAGE" > /dev/null
  start_registry 12id-kit-build "$BUILD_PORT" "$out/registry"
  trap 'docker rm -f 12id-kit-build > /dev/null 2>&1 || true' EXIT
  local var src path tag digest n=0
  : > "$out/images.list"
  while read -r var src path tag digest; do
    skopeo copy --all --preserve-digests --retry-times 3 -q --dest-tls-verify=false \
      "docker://$src" "docker://127.0.0.1:$BUILD_PORT/$path:$tag"
    check_digest "127.0.0.1:$BUILD_PORT" "$path" "$digest" --tls-verify=false
    printf '%s %s %s %s\n' "$var" "$path" "$tag" "$digest" >> "$out/images.list"
    say "  $path:$tag@${digest:7:12}"
    n=$((n + 1))
  done < <(images "$env")
  docker rm -f 12id-kit-build > /dev/null; trap - EXIT

  say "tool images and binaries"
  docker tag "$REGISTRY_IMAGE" "$KIT_REGISTRY_IMAGE"
  docker tag "$SKOPEO_IMAGE" "$KIT_SKOPEO_IMAGE"
  docker save -o "$out/tools/registry.tar" "$KIT_REGISTRY_IMAGE"
  docker save -o "$out/tools/skopeo.tar" "$KIT_SKOPEO_IMAGE"
  local tmp; tmp="$(mktemp -d)"
  fetch() { curl -fsSL -o "$tmp/$1" "$2"; [ "$(sha256sum < "$tmp/$1" | cut -c1-64)" = "$3" ] || die "$2: checksum differs from the pin"; }
  fetch sops "$SOPS_URL" "$SOPS_SHA256" && install -m 0755 "$tmp/sops" "$out/bin/sops"
  fetch age.tgz "$AGE_URL" "$AGE_SHA256" && tar -xzf "$tmp/age.tgz" -C "$tmp" && install -m 0755 "$tmp/age/age" "$tmp/age/age-keygen" "$out/bin/"
  fetch minisign.tgz "$MINISIGN_URL" "$MINISIGN_SHA256" && tar -xzf "$tmp/minisign.tgz" -C "$tmp" && install -m 0755 "$tmp/minisign-linux/x86_64/minisign" "$out/bin/"
  rm -rf "$tmp"

  cp "$env" "$out/release-$version.env"
  [ -z "$bundle" ] || cp "$bundle" "$out/"
  [ -z "$maven" ] || cp -r "$maven" "$out/maven"
  cat > "$out/README.txt" <<EOF
12iD offline kit, release $version ($n images).
1. Check it with 12iD's release public key, received separately:  infra/scripts/offline-kit.sh verify <this dir> --pub <key>
   (the script is also in the bundle; bin/minisign verifies too, but check bin/'s sums against 12iD's notes if you use it).
2. Unpack the bundle into /opt/12id, then load the images:  /opt/12id/infra/scripts/offline-kit.sh load <this dir>
3. Continue with infra/self-host.md ("Getting the images" and "First-time setup").
maven/: the 12iD Android artifacts and DEPENDENCIES.md, for the organisation's Maven repository.
EOF
  (cd "$out" && find . -type f ! -name SHA256SUMS ! -name SHA256SUMS.minisig -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum > SHA256SUMS)
  if [ -n "$key" ]; then
    minisign -S -s "$key" -m "$out/SHA256SUMS" -t "12iD offline kit $version"
  else
    say "warning: not signed (--sign-key); a customer cannot verify this kit"
  fi
  say "kit $out: $n images, $(du -sh "$out" | cut -f1), $(wc -l < "$out/SHA256SUMS") files"
}

cmd_verify() {
  local dir="${1:?verify DIR --pub FILE}" pub="" mini=minisign
  shift
  [ "${1:-}" = --pub ] && pub="${2:-}"
  [ -f "$pub" ] || die "verify needs --pub <12iD's release public key, received separately from the kit>"
  command -v minisign > /dev/null || { mini="$dir/bin/minisign"; say "note: using the kit's own minisign"; }
  "$mini" -Vm "$dir/SHA256SUMS" -p "$pub" || die "the signature does not verify: do not use this kit"
  (cd "$dir" && sha256sum -c --quiet SHA256SUMS) || die "a file does not match SHA256SUMS: do not use this kit"
  say "verified: $(sed -n 1p "$dir/README.txt")"
}

cmd_load() {
  local dir="${1:?load DIR}" registry="" out=/opt/12id/infra/compose/release.env env var path tag digest target t
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --registry) registry="${2:?}"; shift 2 ;;
      --release-env-out) out="${2:?}"; shift 2 ;;
      *) die "load: unknown option $1" ;;
    esac
  done
  dir="$(cd "$dir" && pwd)"
  env="$(ls "$dir"/release-*.env | head -1)"
  (cd "$dir" && sha256sum -c --quiet SHA256SUMS) || die "a file does not match SHA256SUMS (run verify first)"
  for t in sops age age-keygen minisign; do
    command -v "$t" > /dev/null || { sudo install -m 0755 "$dir/bin/$t" /usr/local/bin/; say "installed $t from the kit"; }
  done
  # From here on the tool images come from the kit, never from the internet.
  docker load -q -i "$dir/tools/registry.tar" > /dev/null
  docker load -q -i "$dir/tools/skopeo.tar" > /dev/null
  REGISTRY_IMAGE="$KIT_REGISTRY_IMAGE"
  SKOPEO_IMAGE="$KIT_SKOPEO_IMAGE"

  if [ -z "$registry" ]; then
    target="127.0.0.1:$LOCAL_PORT"
    # Another program on the port would answer instead of ours (found in the rehearsal: an old registry).
    if ! docker ps -q --filter name='^12id-registry$' | grep -q . && curl -s -o /dev/null -m 3 "http://$target/" 2> /dev/null; then
      die "something already listens on $target; stop it, or choose another port with LOCAL_PORT"
    fi
    # The kit's storage into the volume (content-addressed, so a later kit adds to it), then the registry.
    docker volume create 12id-registry > /dev/null
    docker run --rm -v 12id-registry:/var/lib/registry -v "$dir/registry:/src:ro" --entrypoint sh "$REGISTRY_IMAGE" \
      -c 'cp -a /src/. /var/lib/registry/ && chown -R root:root /var/lib/registry'
    # Always a fresh container (the images live in the volume): one left over from an earlier attempt may be
    # stopped or bound to another port (found in the rehearsal).
    docker rm -f 12id-registry > /dev/null 2>&1 || true
    docker run -d --name 12id-registry --restart always -p "$target:5000" \
      -v 12id-registry:/var/lib/registry "$REGISTRY_IMAGE" > /dev/null
    t=0
    until curl -fsS -o /dev/null "http://$target/v2/" 2> /dev/null; do t=$((t + 1)); [ "$t" -lt 30 ] || die "12id-registry does not start"; sleep 1; done
    while read -r var path tag digest; do
      check_digest "$target" "$path" "$digest" --tls-verify=false
    done < "$dir/images.list"
    say "local registry $target holds $(wc -l < "$dir/images.list") images, digests unchanged"
  else
    target="$registry"
    start_registry 12id-kit-push "$PUSH_PORT" "$dir/registry" ro
    trap 'docker rm -f 12id-kit-push > /dev/null 2>&1 || true' EXIT
    while read -r var path tag digest; do
      skopeo copy --all --preserve-digests --retry-times 3 -q --src-tls-verify=false \
        --dest-tls-verify="$TARGET_TLS_VERIFY" "docker://127.0.0.1:$PUSH_PORT/$path@$digest" "docker://$target/$path:$tag"
      check_digest "$target" "$path" "$digest" --tls-verify="$TARGET_TLS_VERIFY"
      say "  $target/$path:$tag"
    done < "$dir/images.list"
    docker rm -f 12id-kit-push > /dev/null; trap - EXIT
  fi

  # release.env pointing at the target; every digest as 12iD released it.
  {
    echo "# Offline kit: $(sed -n 1p "$dir/README.txt"), loaded into $target $(date -u +%Y-%m-%dT%H:%M:%SZ)."
    while IFS= read -r line; do
      case "$line" in
        REGISTRY=*) echo "REGISTRY=$target" ;;
        [A-Z]*_IMAGE=*)
          var="${line%%=*}"
          read -r _ path tag digest < <(grep "^$var " "$dir/images.list")
          echo "$var=$target/$path:$tag@$digest" ;;
        *) echo "$line" ;;
      esac
    done < "$env"
  } > "$out.new"
  mv "$out.new" "$out"
  say "wrote $out (REGISTRY=$target)"
}

case "${1:-}" in
  build) shift; cmd_build "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  load) shift; cmd_load "$@" ;;
  *) die "usage: offline-kit.sh build|verify|load … (see the header)" ;;
esac
