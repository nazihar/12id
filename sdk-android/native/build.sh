#!/usr/bin/env bash
# Builds the three UniFFI wrapper libraries (Askar, AnonCreds, Indy VDR) for Android from the pinned
# upstream sources (versions.env) into jniLibs/<abi>/, then checks that every library loads on
# its minimum API level. Linux host only: CI (ubuntu-24.04) or a WSL distro locally (README.md).
#
# Needs: rustup, cargo-ndk 4 (`cargo install cargo-ndk --locked`), perl + make (OpenSSL is built from
# source), git, and ANDROID_NDK_HOME pointing at NDK r27c (NDK_REVISION).
#
#   NATIVE_WORK=/path/outside/the/repo ./build.sh     # clone + cargo target dirs (default .work)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=versions.env
. "$here/versions.env"

work="${NATIVE_WORK:-$here/.work}"
out="$here/jniLibs"
ndk="${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME to NDK r27c}"
llvm="$ndk/toolchains/llvm/prebuilt/linux-x86_64"

have="$(sed -n 's/^Pkg.Revision *= *//p' "$ndk/source.properties")"
[ "$have" = "$NDK_REVISION" ] || { echo "NDK $have found, $NDK_REVISION expected" >&2; exit 1; }
rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal >/dev/null
rustup target add --toolchain "$RUST_TOOLCHAIN" \
  aarch64-linux-android armv7-linux-androideabi x86_64-linux-android >/dev/null

# --- sources -------------------------------------------------------------------------------------
src="$work/src"
if [ ! -d "$src/.git" ]; then
  git clone --quiet --no-checkout "$UPSTREAM_REPO" "$src"
fi
git -C "$src" fetch --quiet origin "refs/tags/$UPSTREAM_TAG:refs/tags/$UPSTREAM_TAG"
git -C "$src" -c advice.detachedHead=false checkout --quiet --force "$UPSTREAM_COMMIT"
[ "$(git -C "$src" rev-parse "$UPSTREAM_TAG^{commit}")" = "$UPSTREAM_COMMIT" ] \
  || { echo "tag $UPSTREAM_TAG no longer points at $UPSTREAM_COMMIT" >&2; exit 1; }

# --- build ---------------------------------------------------------------------------------------
# Upstream built these with `cross`, which left compiler-rt's builtins out: the x86_64 libraries
# referenced __extenddftf2 and failed to load on every Android version (4-init trap 42).
# --link-builtins links them statically. libc++ is linked statically too, so the AAR ships no
# libc++_shared.so that could clash with the app's own. 16 KB page alignment is required by
# Android 15+ devices with 16 KB pages (and by Google Play for new apps).
export CXXSTDLIB=c++_static
export CARGO_PROFILE_RELEASE_STRIP=symbols
rustflags="-C link-arg=-Wl,-z,max-page-size=16384"
targets=()
for abi in $ABIS; do targets+=(-t "$abi"); done
rust_triple() {
  case "$1" in
    arm64-v8a) echo aarch64-linux-android ;;
    armeabi-v7a) echo armv7-linux-androideabi ;;
    x86_64) echo x86_64-linux-android ;;
  esac
}

rm -rf "$out"
mkdir -p "$out"
for crate in askar anoncreds indy-vdr; do
  echo "== $crate"
  extra=""
  # Indy VDR's ZeroMQ is C++. The -lc++_static that cc emits lands before libzmq.a on the link line,
  # so it resolves nothing and the .so is left importing the C++ runtime (the check below caught it).
  # Linking libc++ and libc++abi again at the end of the command line resolves them.
  [ "$crate" = indy-vdr ] && extra=" -C link-arg=-lc++_static -C link-arg=-lc++abi"
  (cd "$src/$crate" && CARGO_TARGET_DIR="$work/target/$crate" RUSTFLAGS="$rustflags$extra" \
    cargo "+$RUST_TOOLCHAIN" ndk --platform "$ANDROID_API" --link-builtins "${targets[@]}" \
      build --release --locked --lib)
  # Copy only the wrapper library: cargo-ndk's -o would also copy dependency crates built as cdylibs
  # (libaries_askar-<hash>.so, …), which nothing loads.
  lib="$(echo "$crate" | tr - _)_uniffi"
  for abi in $ABIS; do
    mkdir -p "$out/$abi"
    cp "$work/target/$crate/$(rust_triple "$abi")/release/lib$lib.so" "$out/$abi/"
  done
done

# --- verify --------------------------------------------------------------------------------------
# Every library may need only these system libraries, and every symbol it imports must exist in
# their API-level stubs: exactly the check the upstream x86_64 libraries would have failed.
triple() {
  case "$1" in
    arm64-v8a) echo aarch64-linux-android ;;
    armeabi-v7a) echo arm-linux-androideabi ;;
    x86_64) echo x86_64-linux-android ;;
  esac
}
allowed_needed="libc.so libdl.so liblog.so libm.so"
fail=0
for abi in $ABIS; do
  stubs="$llvm/sysroot/usr/lib/$(triple "$abi")/$ANDROID_API"
  provided="$(for l in $allowed_needed; do "$llvm/bin/llvm-nm" -D --defined-only "$stubs/$l" | awk '{print $NF}'; done | sed 's/@.*//' | sort -u)"
  for lib in askar_uniffi anoncreds_uniffi indy_vdr_uniffi; do
    so="$out/$abi/lib$lib.so"
    [ -f "$so" ] || { echo "missing $so" >&2; fail=1; continue; }
    needed="$("$llvm/bin/llvm-readelf" -d "$so" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | sort | tr '\n' ' ')"
    for n in $needed; do
      case " $allowed_needed " in *" $n "*) ;; *) echo "$abi/lib$lib.so needs $n" >&2; fail=1 ;; esac
    done
    missing="$(comm -23 <("$llvm/bin/llvm-nm" -D --undefined-only --no-weak "$so" | awk '{print $NF}' | sed 's/@.*//' | sort -u) <(echo "$provided"))"
    if [ -n "$missing" ]; then
      echo "$abi/lib$lib.so imports symbols API $ANDROID_API does not provide:" >&2
      echo "$missing" | sed 's/^/    /' >&2
      fail=1
    fi
    if [ "$abi" != armeabi-v7a ]; then
      align="$("$llvm/bin/llvm-readelf" -lW "$so" | awk '$1=="LOAD"{print $NF}' | sort -u)"
      for a in $align; do
        [ $((a)) -ge 16384 ] || { echo "$abi/lib$lib.so LOAD alignment $a < 16 KB" >&2; fail=1; }
      done
    fi
    printf '%-12s %-26s %9d bytes  needs: %s\n' "$abi" "lib$lib.so" "$(stat -c %s "$so")" "$needed"
  done
done
extra_files="$(find "$out" -type f ! -name '*_uniffi.so')"
[ -z "$extra_files" ] || { echo "unexpected files in $out:" >&2; echo "$extra_files" >&2; fail=1; }
[ "$fail" = 0 ] || { echo "verification FAILED" >&2; exit 1; }

(cd "$out" && find . -name '*.so' | sort | xargs sha256sum > SHA256SUMS)
echo "OK: $out (SHA256SUMS written)"
