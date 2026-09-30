/**
 * Secrets as files (Phase 9 W2, review M11). `infra/scripts/deploy.sh` writes each secret to a
 * root-only file and Compose mounts it under /run/secrets, so no secret value is in the container's
 * configuration (`docker inspect`). Every config loader runs the environment through this first:
 *
 * - `NAME_FILE=/run/secrets/x` sets `NAME` to the file's content, without its trailing newline.
 *   An empty file leaves `NAME` unset, so an optional secret can be an empty file. Setting both
 *   `NAME` and `NAME_FILE` is an error: one of them would be silently ignored.
 * - A connection URL `NAME_URL` with `NAME_URL_PASSWORD` set gets that password in its userinfo.
 *   The URL itself (host, role, database) stays plain configuration; only the password is secret.
 *
 * A copy of services/credo-base/src/file-env.ts (the console is its own package); the mediator
 * image's entrypoint (infra/build/mediator/secrets-entrypoint.sh) implements the same two rules.
 * Server-only (`.server.ts`): env.server.ts and scripts/migrate.ts call it. Relative imports only (Better Auth CLI).
 */
import { readFileSync } from 'node:fs'

const FILE_SUFFIX = '_FILE'
const URL_PASSWORD_SUFFIX = '_URL_PASSWORD'

export function resolveFileEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...env }

  for (const [key, path] of Object.entries(env)) {
    if (!key.endsWith(FILE_SUFFIX) || !path) continue
    const name = key.slice(0, -FILE_SUFFIX.length)
    if (env[name] !== undefined && env[name] !== '') {
      throw new Error(`both ${name} and ${key} are set; use one`)
    }
    let value: string
    try {
      value = readFileSync(path, 'utf8').replace(/\r?\n$/, '')
    } catch (error) {
      throw new Error(`${key}: cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? error}`)
    }
    delete resolved[key]
    if (value === '') delete resolved[name]
    else resolved[name] = value
  }

  for (const [key, password] of Object.entries(resolved)) {
    if (!key.endsWith(URL_PASSWORD_SUFFIX) || !password) continue
    const name = key.slice(0, -'_PASSWORD'.length)
    const raw = resolved[name]
    if (!raw) throw new Error(`${key} is set but ${name} is not`)
    const url = new URL(raw)
    if (url.password) throw new Error(`${name} already carries a password; set it in one place`)
    url.password = password
    resolved[name] = url.toString()
    delete resolved[key]
  }

  return resolved
}
