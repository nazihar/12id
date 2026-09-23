/**
 * Credo state transitions → `outbox` rows (A6), consumed by the Phase 3 platform API.
 *
 * - Subscribes once, on the root agent: events for every tenant arrive there tagged
 *   `metadata.contextCorrelationId = "tenant-<id>"` (T1).
 * - Uses Credo's exported enums, never string literals: the connection event's string is
 *   "ConnectionStateChanged", without the DidComm prefix the others carry (T1 trap 3).
 *
 * Guarantee: best effort, not transactional. Credo commits the record to Askar before emitting
 * the event, and the outbox lives in a different Postgres database, so a crash between the two
 * loses the row. The reconciliation job (stuck exchanges, T3a) also re-emits missing states.
 */
import { DidCommConnectionEventTypes, DidCommConnectionRepository, DidCommCredentialEventTypes, DidCommProofEventTypes } from '@credo-ts/didcomm'
import type { Logger as PinoLogger } from 'pino'

import type { RootAgent } from '../agent/root-agent.ts'
import type { Database } from '../db/client.ts'
import { type CorrelationKind, type PendingCorrelations, getCorrelationId, setCorrelationId } from './correlation.ts'
import { type OutboxInsert, insertOutboxRow } from './outbox-writer.ts'

const TENANT_CONTEXT_PREFIX = 'tenant-'

interface ExchangeRecordLike {
  id: string
  state: string
  threadId?: string
  connectionId?: string
  outOfBandId?: string
  protocolVersion?: string
  isVerified?: boolean
  metadata: { get(key: string): Record<string, unknown> | null; set(key: string, value: Record<string, unknown>): void }
}

export interface CredoStateEvent {
  type: string
  metadata?: { contextCorrelationId?: string }
  payload: {
    previousState?: string | null
    connectionRecord?: ExchangeRecordLike
    credentialExchangeRecord?: ExchangeRecordLike
    proofRecord?: ExchangeRecordLike
  }
}

/**
 * Pure mapping, so it can be tested without an agent. Returns null for non-tenant contexts.
 * When the record carries no correlation id yet, a pending one (announced before the Credo call)
 * is consumed and stamped onto the record; the caller persists the record.
 */
export function toOutboxRow(event: CredoStateEvent, pending?: PendingCorrelations): { row: OutboxInsert; stampedRecord: ExchangeRecordLike | null } | null {
  const context = event.metadata?.contextCorrelationId
  if (!context?.startsWith(TENANT_CONTEXT_PREFIX)) return null
  const tenantId = context.slice(TENANT_CONTEXT_PREFIX.length)

  let recordType: OutboxInsert['recordType']
  let record: ExchangeRecordLike | undefined
  switch (event.type) {
    case DidCommConnectionEventTypes.DidCommConnectionStateChanged:
      recordType = 'connection'
      record = event.payload.connectionRecord
      break
    case DidCommCredentialEventTypes.DidCommCredentialStateChanged:
      recordType = 'credential'
      record = event.payload.credentialExchangeRecord
      break
    case DidCommProofEventTypes.ProofStateChanged:
      recordType = 'proof'
      record = event.payload.proofRecord
      break
    default:
      return null
  }
  if (!record) return null

  const payload: Record<string, unknown> = {}
  if (record.connectionId) payload.connectionId = record.connectionId
  if (record.outOfBandId) payload.outOfBandId = record.outOfBandId
  if (record.protocolVersion) payload.protocolVersion = record.protocolVersion
  if (typeof record.isVerified === 'boolean') payload.isVerified = record.isVerified

  let correlationId = getCorrelationId(record)
  let stampedRecord: ExchangeRecordLike | null = null
  if (!correlationId && pending) {
    // Credo can emit several events for one record before the stamped copy is persisted
    // (connection: request-received → response-sent → completed in one pass), so the listener
    // remembers what it stamped per record id.
    correlationId = pending.recall(tenantId, recordType as CorrelationKind, record.id)
    if (correlationId) {
      setCorrelationId(record, correlationId)
    } else {
      const anchor = recordType === 'connection' ? record.outOfBandId : record.connectionId
      if (anchor) {
        correlationId = pending.consume(tenantId, recordType as CorrelationKind, anchor)
        if (correlationId) {
          pending.remember(tenantId, recordType as CorrelationKind, record.id, correlationId)
          setCorrelationId(record, correlationId)
          stampedRecord = record
        }
      }
    }
  }

  return {
    row: {
      tenantId,
      recordType,
      recordId: record.id,
      threadId: record.threadId ?? null,
      state: record.state,
      previousState: event.payload.previousState ?? null,
      correlationId,
      payload,
    },
    stampedRecord,
  }
}

export function startOutboxListener(agent: RootAgent, db: Database, logger: PinoLogger, pending: PendingCorrelations) {
  const log = logger.child({ component: 'outbox' })
  const types = [
    DidCommConnectionEventTypes.DidCommConnectionStateChanged,
    DidCommCredentialEventTypes.DidCommCredentialStateChanged,
    DidCommProofEventTypes.ProofStateChanged,
  ]
  const subscriptions = types.map((type) =>
    agent.events.observable<CredoStateEvent & { metadata: { contextCorrelationId: string } }>(type).subscribe((event) => {
      const mapped = toOutboxRow(event, pending)
      if (!mapped) return
      const { row, stampedRecord } = mapped
      if (stampedRecord) {
        // Persist the stamped metadata so later events (and restarts) carry the id from the record.
        const tenantId = row.tenantId
        agent.modules.tenants
          .withTenantAgent({ tenantId }, async (t) => {
            if (row.recordType === 'credential') await t.modules.didcomm.credentials.update(stampedRecord as never)
            else if (row.recordType === 'proof') await t.modules.didcomm.proofs.update(stampedRecord as never)
            else await t.dependencyManager.resolve(DidCommConnectionRepository).update(t.context, stampedRecord as never)
          })
          .catch((error: unknown) => log.warn({ err: error, recordId: row.recordId }, 'could not persist correlation id on record'))
      }
      insertOutboxRow(db, row).then(
        () => log.debug({ tenantId: row.tenantId, recordType: row.recordType, state: row.state, threadId: row.threadId }, 'outbox row written'),
        (error: unknown) =>
          log.error({ err: error, tenantId: row.tenantId, recordType: row.recordType, recordId: row.recordId, state: row.state }, 'outbox write failed')
      )
    })
  )
  return () => {
    for (const subscription of subscriptions) subscription.unsubscribe()
  }
}
