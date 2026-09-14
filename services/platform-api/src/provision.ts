/**
 * One-shot provisioning job: creates the platform_api database if missing and applies
 * migrations. Runs before platform-api starts, from exactly one container.
 */
import { createServiceLogger } from '@12id/credo-base/logger.ts'

import { loadConfig } from './config.ts'
import { ensureDatabase, runMigrations } from './db/migrate.ts'

const config = loadConfig()
const logger = createServiceLogger({ name: 'platform-provision', level: config.LOG_LEVEL })

try {
  const database = await ensureDatabase(config.DATABASE_URL)
  await runMigrations(config.DATABASE_URL)
  logger.info({ database }, 'platform database migrated')
  process.exit(0)
} catch (error) {
  logger.error({ err: error }, 'provisioning failed')
  process.exit(1)
}
