#!/usr/bin/env bash
# Assembles the public documentation site (docs.12id.com, Phase 9 W7) into <out>: the customer guides as they
# are in the repo, the OpenAPI document and the reference page, with repo paths rewritten into site links.
# GitHub Pages renders the markdown (Jekyll, _config.yml). Run from the repo root:
#   docs/site/build.sh <out-dir>
set -euo pipefail
out="${1:?usage: docs/site/build.sh <out-dir>}"
mkdir -p "$out"

cp docs/site/index.md docs/site/_config.yml docs/site/reference.html "$out/"
cp services/platform-api/docs/api.md services/platform-api/docs/credential-model.md \
   services/platform-api/docs/data-protection.md "$out/"
cp sdk-android/docs/integration.md "$out/android-sdk.md"
cp services/platform-api/openapi.json "$out/openapi.json"
echo "docs.12id.com" > "$out/CNAME"

# Repo paths in the guides become links to the published pages.
sed -i \
  -e 's#`sdk-android/docs/integration\.md`#[the Android SDK guide](android-sdk.md)#g' \
  -e 's#`services/platform-api/docs/api\.md`#[the Platform API guide](api.md)#g' \
  -e 's#(also committed as `openapi\.json`)#(also [published here](openapi.json), rendered as the [API reference](reference.html))#g' \
  "$out"/*.md

# No internal paths may leak into the public site.
if grep -nE 'implement/|infra/|C:\\|E:\\' "$out"/*.md; then
  echo "internal paths in the public docs (above); fix the source guides" >&2
  exit 1
fi
echo "site assembled in $out: $(ls "$out" | tr '\n' ' ')"
