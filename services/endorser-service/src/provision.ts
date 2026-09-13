/**
 * endorser-service provision step: its own database and migrations only.
 *
 * It deliberately does NOT provision the Askar store. The endorser store and DID are created
 * once per environment by infra/ledger bootstrap-endorser; creating a store here would turn a
 * wrong ASKAR_STORE_ID into a brand-new, unregistered endorser key.
 */
import { fileURLToPath } from 'node:url'

import { createServiceLogger } from '@12id/credo-base/logger.ts'
import { ensureDatabase, runMigrations } from '@12id/credo-base/postgres-migrate.ts'

import { loadConfig } from './config.ts'

const config = loadConfig()
const logger = createServiceLogger({ name: 'endorser-provision', level: config.LOG_LEVEL })

try {
  const database = await ensureDatabase(config.DATABASE_URL)
  await runMigrations(config.DATABASE_URL, fileURLToPath(new URL('../drizzle', import.meta.url)))
  logger.info({ database }, 'endorser-service database migrated')
  process.exit(0)
} catch (error) {
  logger.error({ err: error }, 'endorser-service provisioning failed')
  process.exit(1)
}
