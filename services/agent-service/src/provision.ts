/**
 * One-shot provisioning job (A1). Runs BEFORE agent-service starts, from exactly one container:
 * concurrent provisioning of one Askar store races on CREATE SCHEMA (6-phase-1-findings W4).
 *
 * It creates the root store if missing, then initializes and shuts the agent down once, so the
 * storage version record is written here and not by the first service start.
 *
 * Exit code 0 means the store exists and opened with the configured key.
 */
// Native bindings before any module that imports @credo-ts/* (askar-postgres does).
import '@12id/credo-base/bindings.ts'

import { provisionStoreIfMissing } from '@12id/credo-base/askar-postgres.ts'
import { createServiceLogger } from '@12id/credo-base/logger.ts'

import { createRootAgent } from './agent/root-agent.ts'
import { loadConfig } from './config.ts'
import { ensureDatabase, runMigrations } from './db/migrate.ts'

const config = loadConfig()
const logger = createServiceLogger({ name: 'agent-provision', level: config.LOG_LEVEL })

let exitCode = 0
const agent = await createRootAgent(config, logger)
try {
  // Service tables first: cheap, and a failure here should not leave a half-used store.
  const database = await ensureDatabase(config.DATABASE_URL)
  await runMigrations(config.DATABASE_URL)
  logger.info({ database }, 'service database migrated')

  const store = await provisionStoreIfMissing(agent)
  // On an existing store Askar logs an `[error] … rollback {"error":{"code":3}}` line just
  // before the duplicate is caught; `store: existing` below is the authoritative outcome.
  await agent.initialize()
  const tenants = await agent.modules.tenants.getAllTenants()
  logger.info({ store, storeId: config.ASKAR_STORE_ID, tenants: tenants.length }, 'root store ready')
} catch (error) {
  logger.error({ err: error }, 'provisioning failed')
  exitCode = 1
} finally {
  await agent.shutdown().catch((error: unknown) => logger.error({ err: error }, 'shutdown after provisioning failed'))
}
process.exit(exitCode)
