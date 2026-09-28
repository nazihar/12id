/**
 * platform-api entry point. Assumes `provision.ts` has migrated the database.
 *
 * One process runs the HTTP API, the outbox consumer and the webhook dispatcher (single replica
 * in Phase 3, like agent-service). SIGTERM: readiness → 503, stop the workers, wait for in-flight
 * deliveries, close the server and the pools.
 */
import { createServiceLogger } from '@12id/credo-base/logger.ts'

import { createAgentClient } from './agent-client.ts'
import { createBiometricClient } from './biometric-client.ts'
import { createGateEngine } from './biometric/gate.ts'
import { loadConfig } from './config.ts'
import { createDatabase } from './db/client.ts'
import { buildApp, type ReadinessReport } from './http/app.ts'
import { expireIdempotencyKeys } from './http/idempotency.ts'
import { createMediatorClient } from './mediator-client.ts'
import { createOutboxConsumer } from './outbox-consumer.ts'
import { handleMediatorWebhook } from './wake.ts'
import { startRetention } from './retention.ts'
import { startSweep } from './sweep.ts'
import { createDispatcher } from './webhooks/dispatcher.ts'
import { endpointLookup } from './webhooks/events.ts'

const config = loadConfig()
const logger = createServiceLogger({ name: 'platform-api', level: config.LOG_LEVEL })

let draining = false
const { pool, db } = createDatabase(config.DATABASE_URL)
const agent = createAgentClient({ baseUrl: config.AGENT_API_URL, token: config.AGENT_API_TOKEN, catalogueTtlMs: config.CATALOGUE_CACHE_MS })
const mediator = createMediatorClient({ adminUrl: config.MEDIATOR_ADMIN_URL, adminToken: config.MEDIATOR_ADMIN_TOKEN, drizzleUrl: config.MEDIATOR_DRIZZLE_URL })
const endpoints = endpointLookup(db)
// Phase 6: without both settings nothing is gated and the biometric routes do not exist.
const biometricClient = config.BIOMETRIC_SERVICE_URL && config.BIOMETRIC_SERVICE_TOKEN ? createBiometricClient({ baseUrl: config.BIOMETRIC_SERVICE_URL, token: config.BIOMETRIC_SERVICE_TOKEN }) : undefined
const gates = biometricClient ? createGateEngine({ db, agent, biometric: biometricClient, endpoints, logger }) : undefined

async function readiness(): Promise<ReadinessReport> {
  const [database, agentOk, mediatorDb, biometricOk] = await Promise.all([
    pool.query('select 1').then(() => true, () => false),
    agent.healthy(),
    mediator.healthy(),
    biometricClient ? biometricClient.healthy() : Promise.resolve(true),
  ])
  return { ready: database && agentOk && !draining, draining, checks: { database, agent: agentOk, mediatorDatabase: mediatorDb, ...(biometricClient ? { biometric: biometricOk } : {}) } }
}

const app = buildApp({
  config,
  db,
  agent,
  mediator,
  logger,
  readiness,
  wake: (connectionId) => handleMediatorWebhook({ db, mediator, endpoints, logger, debounceMs: config.WAKE_DEBOUNCE_MS }, connectionId),
  biometric: biometricClient && gates ? { client: biometricClient, gates } : undefined,
})

const consumer = createOutboxConsumer({ db, agent, logger, endpoints, batch: config.OUTBOX_BATCH, gates })
const dispatcher = createDispatcher({ db, logger, timeoutMs: config.WEBHOOK_TIMEOUT_MS, maxAttempts: config.WEBHOOK_MAX_ATTEMPTS, concurrency: config.WEBHOOK_CONCURRENCY, perTenant: config.WEBHOOK_PER_TENANT })

await app.listen({ host: config.HOST, port: config.PORT })
const stopConsumer = consumer.start(config.OUTBOX_POLL_MS)
const stopDispatcher = dispatcher.start(config.WEBHOOK_POLL_MS)
// Wallet and mediator housekeeping (review M10, M4).
const stopSweep = config.SWEEP_INTERVAL_MS > 0
  ? startSweep({ db, mediator, logger, unconnectedRevokeDays: config.WALLET_UNCONNECTED_REVOKE_DAYS, revokedGraceDays: config.WALLET_REVOKED_GRACE_DAYS, invitationTtlHours: config.MEDIATOR_INVITATION_TTL_HOURS, queueTtlDays: config.MEDIATOR_QUEUE_TTL_DAYS }, config.SWEEP_INTERVAL_MS)
  : async () => undefined
const expiry = setInterval(() => void expireIdempotencyKeys(db, config.IDEMPOTENCY_TTL_MS).catch((error: unknown) => logger.warn({ err: error }, 'idempotency expiry failed')), 10 * 60 * 1000)
// Biometric gates past their TTL are expired and their exchanges abandoned; unsettled gates are retried.
// Retention (Phase 7 H1) runs on the sweep's schedule; SWEEP_INTERVAL_MS 0 turns both off.
const stopRetention = config.SWEEP_INTERVAL_MS > 0
  ? startRetention({ db, agent, biometric: biometricClient, endpoints, logger, defaultDays: config.RETENTION_DAYS }, config.SWEEP_INTERVAL_MS)
  : async () => undefined
const gateExpiry = gates ? setInterval(() => void gates.expireDue().catch((error: unknown) => logger.warn({ err: error }, 'biometric gate expiry failed')), config.BIOMETRIC_EXPIRY_POLL_MS) : undefined

async function drain(signal: string) {
  if (draining) return
  draining = true
  const started = Date.now()
  logger.info({ signal }, 'drain started')
  clearInterval(expiry)
  if (gateExpiry) clearInterval(gateExpiry)
  await Promise.all([stopConsumer(), stopDispatcher(), stopSweep(), stopRetention()])
  const deadline = started + config.DRAIN_DEADLINE_MS
  while (dispatcher.inFlight() > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  await app.close()
  await mediator.close()
  await pool.end()
  logger.info({ durationMs: Date.now() - started, inFlight: dispatcher.inFlight() }, 'drain complete')
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void drain(signal).then(() => process.exit(0), (error: unknown) => {
      logger.error({ err: error }, 'drain failed')
      process.exit(1)
    })
  })
}

logger.info({ host: config.HOST, port: config.PORT, publicUrl: config.PUBLIC_URL, agentApi: config.AGENT_API_URL, mediatorAdmin: config.MEDIATOR_ADMIN_URL, biometric: !!gates }, 'platform-api ready')
