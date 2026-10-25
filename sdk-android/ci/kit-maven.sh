#!/usr/bin/env bash
# The offline kit's Maven part (implement/28 Q5): 12iD's four Android artifacts at one released version, as they
# are on maven.12id.com, and DEPENDENCIES.md, the public libraries they need, for the customer's Maven proxy.
# Not a full mirror (owner decision 2026-10-15).
#
#   sdk-android/ci/kit-maven.sh <out-dir>        run at the SDK release's commit (versions from gradle.properties)
#
# Then: infra/scripts/offline-kit.sh build … --maven <out-dir>
set -euo pipefail

out="${1:?usage: kit-maven.sh <out-dir>}"
sdk_dir="$(cd "$(dirname "$0")/.." && pwd)"
prop() { sed -n "s/^$1=//p" "$sdk_dir/gradle.properties"; }
sdk_version="${SDK_VERSION:-$(prop sdkVersion)}"   # SDK_VERSION: a rehearsal against an earlier release
native_version="$(prop nativeVersion)"
[ ! -e "$out" ] || { echo "$out exists; use a new directory" >&2; exit 1; }

repo="$(mktemp -d)"
trap 'rm -rf "$repo"' EXIT
git clone --quiet --depth 1 https://github.com/nazihar/12id-maven "$repo"

copy() { # artifactId version
  local src="$repo/com/12id/$1/$2"
  [ -d "$src" ] || { echo "com.12id:$1:$2 is not published on maven.12id.com" >&2; exit 1; }
  mkdir -p "$out/com/12id/$1"
  cp -r "$src" "$out/com/12id/$1/"
  echo "com.12id:$1:$2"
}
mkdir -p "$out"
{
  copy holder-sdk-android "$sdk_version"
  copy holder-sdk-android-biometrics-aws "$sdk_version"
  copy holder-sdk-android-biometrics-mock "$sdk_version"
  copy holder-sdk-native "$native_version"
} > "$out/.artifacts"

# What a consumer's build resolves besides 12iD's artifacts: the release runtime classpath of the SDK and of the
# AWS add-on (the mock add-on adds nothing). `a:b:1.0 -> 1.1` is reported as the resolved 1.1.
# A task option belongs to the task before it, so each task names the configuration.
deps="$(cd "$sdk_dir" && ./gradlew -q :sdk:dependencies --configuration releaseRuntimeClasspath \
  :biometrics-aws:dependencies --configuration releaseRuntimeClasspath \
  | awk '/--- / && !/\(c\)$/ && !/--- project / {
      s = $0; sub(/^.*--- /, "", s)
      coord = s; sub(/ .*/, "", coord)
      n = split(coord, p, ":"); v = (n >= 3 ? p[3] : "")
      if (s ~ / -> /) { r = s; sub(/^.* -> /, "", r); sub(/ .*/, "", r); v = r }
      if (v == "" || v ~ /[{}]/) next
      print p[1] ":" p[2] ":" v
    }' \
  | grep -v '^com\.12id:' | LC_ALL=C sort -u)"

{
  echo "# 12iD Android SDK $sdk_version: what the Maven part holds and what it needs"
  echo
  echo "**12iD's artifacts** (in this directory, Maven layout; upload to a hosted repository, or point Gradle at"
  echo "it as \`maven(\"file:///…/maven\")\`):"
  echo
  sed 's/^/- `/; s/$/`/' "$out/.artifacts"
  echo
  echo "**Public libraries they need** at run time ($(printf '%s\n' "$deps" | grep -c .) coordinates), from Google's Maven"
  echo "repository (\`https://maven.google.com\`) and Maven Central. A proxy of those two repositories serves them; an"
  echo "app with its own versions of some of them gets Gradle's usual conflict resolution."
  echo
  printf '%s\n' "$deps" | sed 's/^/- `/; s/$/`/'
} > "$out/DEPENDENCIES.md"
rm -f "$out/.artifacts"
echo "Maven part in $out: $(find "$out/com" -type f | wc -l) files, DEPENDENCIES.md with $(printf '%s\n' "$deps" | grep -c .) coordinates"
