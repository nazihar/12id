import { fileURLToPath } from 'node:url'

import { ensureDatabase, runMigrations as runDrizzleMigrations } from '@12id/credo-base/postgres-migrate.ts'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url))

export { ensureDatabase }

/** Applies agent-service migrations from ./drizzle. Run from the provision job only. */
export function runMigrations(url: string) {
  return runDrizzleMigrations(url, MIGRATIONS_FOLDER)
}
