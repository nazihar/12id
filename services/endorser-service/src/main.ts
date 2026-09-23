/**
 * endorser-service entry point. Internal network only (D5). Requires the database to be
 * migrated (provision.ts) and the endorser store to exist (infra/ledger bootstrap-endorser).
 */
// Native bindings before any module that imports @credo-ts/* (4-init §7.1).
import '@12id/credo-base/bindings.ts'

import { createServiceLogger } from '@12id/credo-base/logger.ts'

import { assertEndorserDidInStore, createEndorserAgent } from './agent/endorser-agent.ts'
import { loadConfig } from './config.ts'
import { createTenantBindings } from './db/bindings.ts'
import { createAuditWriter, createDatabase } from './db/client.ts'
import { buildEndorserApi } from './http/endorser-api.ts'

const config = loadConfig()
const logger = createServiceLogger({ name: 'endorser-service', level: config.LOG_LEVEL })
const endorserNym = config.ENDORSER_DID.split(':').pop() as string

const { pool, db } = createDatabase(config.DATABASE_URL)
const agent = await createEndorserAgent(config, logger)

try {
  await agent.initialize()
  await assertEndorserDidInStore(agent, config.ENDORSER_DID)
} catch (error) {
  logger.fatal({ err: error }, 'endorser-service failed to start')
  await agent.shutdown().catch(() => undefined)
  await pool.end().catch(() => undefined)
  process.exit(1)
}

const api = buildEndorserApi({
  logger,
  token: config.INTERNAL_TOKEN,
  endorserNym,
  bindings: createTenantBindings(db),
  sign: (request) => agent.modules.indyVdr.endorseTransaction(request, config.ENDORSER_DID),
  audit: createAuditWriter(db),
  dailyLedgerWriteCeiling: config.ENDORSER_DAILY_CEILING,
})
await api.listen({ host: config.HOST, port: config.PORT })

let stopping: Promise<void> | undefined
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // Close the API first (waits for in-flight signing requests), then the store.
    stopping ??= (async () => {
      logger.info({ signal }, 'endorser-service stopping')
      await api.close().catch((error: unknown) => logger.error({ err: error }, 'api close failed'))
      await agent.shutdown().catch((error: unknown) => logger.error({ err: error }, 'agent shutdown failed'))
      await pool.end().catch(() => undefined)
      process.exit(0)
    })()
  })
}

logger.info({ endorserDid: config.ENDORSER_DID, listen: `${config.HOST}:${config.PORT}` }, 'endorser-service ready')
