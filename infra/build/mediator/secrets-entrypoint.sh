#!/bin/sh
# Mediator entrypoint (Phase 9 W2, review M11): secrets arrive as files, not in the container config.
#
# The upstream mediator reads its settings only from environment variables. This wrapper applies the
# platform's two rules (services/credo-base/src/file-env.ts) and then execs the unchanged command:
#   NAME_FILE=/run/secrets/x    NAME becomes the file's content (an empty file leaves NAME unset)
#   NAME_URL_PASSWORD           is put into NAME_URL's userinfo, percent-encoded
# The values leave `docker inspect`, but they are still in the mediator's own /proc/<pid>/environ,
# because that is the only way the upstream image takes them (accepted, 17-phase-7.md M11).
set -eu

for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)_FILE=.*/\1/p'); do
  eval "file=\${${name}_FILE}"
  eval "current=\${${name}:-}"
  if [ -n "$current" ]; then
    echo "secrets-entrypoint: both $name and ${name}_FILE are set; use one" >&2
    exit 1
  fi
  if [ ! -r "$file" ]; then
    echo "secrets-entrypoint: ${name}_FILE: cannot read $file" >&2
    exit 1
  fi
  # $(...) drops every trailing newline; a secret never ends in one.
  value="$(cat "$file")"
  unset "${name}_FILE"
  if [ -n "$value" ]; then export "$name=$value"; else unset "$name"; fi
done

for key in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*_URL\)_PASSWORD=.*/\1/p'); do
  eval "url=\${${key}:-}"
  if [ -z "$url" ]; then
    echo "secrets-entrypoint: ${key}_PASSWORD is set but $key is not" >&2
    exit 1
  fi
  # Node's URL setter percent-encodes the password; sed could not do that safely.
  url="$(URL_NAME="$key" node -e '
    const name = process.env.URL_NAME
    const url = new URL(process.env[name])
    if (url.password) { console.error(`secrets-entrypoint: ${name} already carries a password`); process.exit(1) }
    url.password = process.env[`${name}_PASSWORD`]
    process.stdout.write(url.toString())
  ')"
  unset "${key}_PASSWORD"
  export "$key=$url"
done

exec "$@"
