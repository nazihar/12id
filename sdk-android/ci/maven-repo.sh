#!/usr/bin/env bash
# The public Maven repository is a checkout of nazihar/maven, served by GitHub Pages at maven.12id.com
# (Phase 9 W3). The release workflows publish into the checkout with -PpublishRepo, so Gradle merges each
# artifact's maven-metadata.xml with the versions already there, and then push it.
#
#   maven-repo.sh assert-new <dir> <artifactId> <version>   refuse to overwrite a released version
#   maven-repo.sh push <dir> <message>                       commit and push (adds CNAME/.nojekyll)
set -euo pipefail

cmd="${1:?usage: maven-repo.sh assert-new <dir> <artifactId> <version> | push <dir> <message>}"
dir="${2:?repository checkout}"

case "$cmd" in
  assert-new)
    artifact="${3:?artifactId}"
    version="${4:?version}"
    # Released versions are immutable: a consumer's build must never change under it.
    if [ -e "$dir/com/12id/$artifact/$version" ]; then
      echo "com.12id:$artifact:$version is already published; bump the version" >&2
      exit 1
    fi
    ;;
  push)
    message="${3:?commit message}"
    echo "maven.12id.com" > "$dir/CNAME"
    touch "$dir/.nojekyll" # serve every file as is, no Jekyll build
    git -C "$dir" add -A
    git -C "$dir" -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
      commit --quiet -m "$message"
    git -C "$dir" push --quiet origin HEAD
    git -C "$dir" log --oneline -1
    ;;
  *)
    echo "unknown command $cmd" >&2
    exit 2
    ;;
esac
