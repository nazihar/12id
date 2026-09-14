/**
 * agent-service entry point. Assumes `provision.ts` has already created the root store and
 * migrated the service database.
 *
 * Ports:
 *   DIDCOMM_PORT       public through Caddy: Credo's POST / plus GET /readyz for health checks
 *   INTERNAL_API_PORT  private network only: platform API commands, /healthz, /readyz
 */
// Native bindings before any module that imports @credo-ts/* (4-init §7.1).
import '@12id/credo-base/bindings.ts'

import { createServiceLogger } from '@12id/credo-base/logger.ts'
import express from 'express'

import { createRootAgent } from './agent/root-agent.ts'
import { loadConfig } from './config.ts'
import { createDatabase } from './db/client.ts'
import { createEndorserClient } from './endorser/endorser-client.ts'
import { PendingCorrelations } from './events/correlation.ts'
import { startOutboxListener } from './events/outbox-listener.ts'
import { startReconciler } from './exchanges/reconcile.ts'
import { commandRoutes } from './http/command-routes.ts'
import { type ReadinessReport, buildInternalApi } from './http/internal-api.ts'
import { type EventSource, InFlightTracker, createDrain } from './lifecycle/drain.ts'

const config = loadConfig()
const logger = createServiceLogger({ name: 'agent-service', level: config.LOG_LEVEL })

let draining = false
const didcommApp = express()
const { pool, db } = createDatabase(config.DATABASE_URL)
const agent = await createRootAgent(config, logger, { didcommApp })

// Subscribe before initialize, so no inbound message is missed by the drain count or the outbox.
const tracker = new InFlightTracker(agent.events as unknown as EventSource)
const pendingCorrelations = new PendingCorrelations()
const stopOutbox = startOutboxListener(agent, db, logger, pendingCorrelations)

async function readiness(): Promise<ReadinessReport> {
  const initialized = agent.isInitialized
  let database = false
  try {
    await pool.query('select 1')
    database = true
  } catch {
    database = false
  }
  return { ready: initialized && database && !draining, draining, checks: { agent: initialized, database } }
}

didcommApp.get('/readyz', async (_request, response) => {
  const report = await readiness()
  response.status(report.ready ? 200 : 503).json({ ready: report.ready, draining: report.draining })
})

try {
  await agent.initialize()
} catch (error) {
  logger.fatal({ err: error }, 'agent initialization failed; was provision.ts run for this store?')
  await agent.shutdown().catch(() => undefined)
  process.exit(1)
}

const endorser = createEndorserClient({ baseUrl: config.ENDORSER_SERVICE_URL, token: config.ENDORSER_SERVICE_TOKEN })
const shared = { agent, db, endorser, endorserDid: config.ENDORSER_DID, logger }
const internalApi = buildInternalApi({
  logger,
  readiness,
  token: config.INTERNAL_API_TOKEN,
  commands: commandRoutes({
    onboarding: shared,
    catalogue: shared,
    exchanges: { agent, db, didcommEndpoint: config.DIDCOMM_ENDPOINT, logger, pendingCorrelations },
    outbox: { db },
  }),
})
await internalApi.listen({ host: config.INTERNAL_API_HOST, port: config.INTERNAL_API_PORT })
const stopReconciler = startReconciler(agent, db, { ttlMs: config.RECONCILE_TTL_MS, intervalMs: config.RECONCILE_INTERVAL_MS }, logger)

const drain = createDrain(
  tracker,
  {
    markDraining: () => {
      draining = true
    },
    closeInternalApi: () => internalApi.close(),
    shutdownAgent: async () => {
      stopReconciler()
      await agent.shutdown()
      stopOutbox()
      await pool.end()
    },
    log: (message, fields) => logger.info(fields ?? {}, message),
  },
  config.DRAIN_DEADLINE_MS
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void drain(signal).then((report) => process.exit(report.error ? 1 : 0))
  })
}

logger.info(
  {
    roles: config.AGENT_ROLES,
    namespace: config.INDY_NAMESPACE,
    didcommEndpoint: config.DIDCOMM_ENDPOINT,
    didcommPort: config.DIDCOMM_PORT,
    internalApi: `${config.INTERNAL_API_HOST}:${config.INTERNAL_API_PORT}`,
    endorserService: config.ENDORSER_SERVICE_URL,
    processMessagesConcurrently: config.PROCESS_MESSAGES_CONCURRENTLY,
  },
  'agent-service ready'
)
