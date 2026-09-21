/**
 * biometric-service provision step: creates the `biometric` database on agent-postgres and applies
 * migrations. One process, before the service starts (same pattern as endorser-service).
 */
import { fileURLToPath } from 'node:url'

import { ensureDatabase, runMigrations } from '@12id/credo-base/postgres-migrate.ts'

import { loadConfig } from './config.ts'
import { createLogger } from './logger.ts'

const config = loadConfig()
const logger = createLogger({ name: 'biometric-provision', level: config.LOG_LEVEL })

try {
  const database = await ensureDatabase(config.DATABASE_URL)
  await runMigrations(config.DATABASE_URL, fileURLToPath(new URL('../drizzle', import.meta.url)))
  logger.info({ database }, 'biometric-service database migrated')
  process.exit(0)
} catch (error) {
  logger.error({ err: error }, 'biometric-service provisioning failed')
  process.exit(1)
}
