/**
 * Stuck-exchange reconciliation (T3a). A failed send desynchronises both sides permanently and
 * nothing in Credo retries: after a crash, issuer records stay at `offer-sent` /
 * `request-sent` forever. This job marks such records abandoned after a TTL, so the platform
 * gets an outbox row and can re-offer on a new thread.
 *
 * Runs on an interval inside agent-service (one replica in v1). It does not re-offer itself:
 * only the platform knows whether the business still wants the credential issued.
 */
import { DidCommCredentialState, DidCommProofState } from '@credo-ts/didcomm'
import type { Logger as PinoLogger } from 'pino'

import type { RootAgent } from '../agent/root-agent.ts'
import type { Database } from '../db/client.ts'
import { outbox } from '../db/schema.ts'
import { getCorrelationId } from '../events/correlation.ts'

/** Issuer/verifier states that wait on the holder. */
// RequestReceived and PresentationReceived are where biometric-gated exchanges park (Phase 6 B2);
// the platform's gate TTL is shorter, so it normally abandons them first.
const WAITING_CREDENTIAL_STATES = [DidCommCredentialState.OfferSent, DidCommCredentialState.CredentialIssued, DidCommCredentialState.RequestReceived]
const WAITING_PROOF_STATES = [DidCommProofState.RequestSent, DidCommProofState.PresentationReceived]

export interface ReconcileOptions {
  /** Records older than this in a waiting state are abandoned. */
  ttlMs: number
  intervalMs: number
}

export async function reconcileOnce(agent: RootAgent, db: Database, options: { ttlMs: number }, logger: PinoLogger) {
  const cutoff = new Date(Date.now() - options.ttlMs)
  const tenants = await agent.modules.tenants.getAllTenants()
  let abandoned = 0
  const isStale = (record: { updatedAt?: Date; createdAt: Date }) => (record.updatedAt ?? record.createdAt) <= cutoff
  const reason = (state: string) => `abandoned by reconciliation after ${options.ttlMs / 1000}s in ${state}`

  for (const tenant of tenants) {
    await agent.modules.tenants
      .withTenantAgent({ tenantId: tenant.id }, async (t) => {
        const credentials = await t.modules.didcomm.credentials.findAllByQuery({ $or: WAITING_CREDENTIAL_STATES.map((state) => ({ state })) })
        for (const record of credentials.filter(isStale)) {
          const previousState = record.state
          // Credo's declineOffer/sendProblemReport need the holder reachable; abandon locally.
          // api.update() emits no state event, so the outbox row is written here.
          record.state = DidCommCredentialState.Abandoned
          record.errorMessage = reason(previousState)
          await t.modules.didcomm.credentials.update(record)
          await db.insert(outbox).values({ tenantId: tenant.id, recordType: 'credential', recordId: record.id, threadId: record.threadId, state: record.state, previousState, correlationId: getCorrelationId(record), payload: { reason: record.errorMessage, connectionId: record.connectionId ?? null } })
          abandoned++
        }
        const proofs = await t.modules.didcomm.proofs.findAllByQuery({ $or: WAITING_PROOF_STATES.map((state) => ({ state })) })
        for (const record of proofs.filter(isStale)) {
          const previousState = record.state
          record.state = DidCommProofState.Abandoned
          record.errorMessage = reason(previousState)
          await t.modules.didcomm.proofs.update(record)
          await db.insert(outbox).values({ tenantId: tenant.id, recordType: 'proof', recordId: record.id, threadId: record.threadId, state: record.state, previousState, correlationId: getCorrelationId(record), payload: { reason: record.errorMessage, connectionId: record.connectionId ?? null } })
          abandoned++
        }
      })
      .catch((error: unknown) => logger.error({ err: error, tenantId: tenant.id }, 'reconciliation failed for tenant'))
  }
  if (abandoned > 0) logger.warn({ abandoned, ttlMs: options.ttlMs }, 'stuck exchanges abandoned')
  return abandoned
}

export function startReconciler(agent: RootAgent, db: Database, options: ReconcileOptions, logger: PinoLogger) {
  const log = logger.child({ component: 'reconcile' })
  const timer = setInterval(() => {
    reconcileOnce(agent, db, options, log).catch((error: unknown) => log.error({ err: error }, 'reconciliation run failed'))
  }, options.intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
