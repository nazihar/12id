/**
 * Event envelopes and the enqueue step. A delivery row is written only when the tenant has a
 * webhook endpoint that subscribes to the type; the body is serialised once here so every retry
 * signs byte-identical content.
 */
import { createHash, randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import type { Database } from '../db/client.ts'
import { webhookDeliveries, webhookEndpoints } from '../db/schema.ts'

export const EVENT_TYPES = ['connection.state_changed', 'credential.state_changed', 'proof.state_changed', 'wallet.sync_requested', 'biometric.check_completed'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export interface EventEnvelope {
  id: string
  type: EventType
  createdAt: string
  tenantId: string
  data: Record<string, unknown>
}

export function buildEnvelope(tenantId: string, type: EventType, data: Record<string, unknown>, now = new Date(), id: string = randomUUID()): EventEnvelope {
  return { id, type, createdAt: now.toISOString(), tenantId, data }
}

/**
 * The event id for an outbox row: a name-based (v5-style) UUID of the row id, so re-applying the
 * same row after a failure enqueues nothing new (review M6). Stable across processes and restarts.
 */
export function outboxEventId(outboxRowId: number): string {
  const hash = createHash('sha1').update(`12id:outbox:${outboxRowId}`).digest()
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export type EndpointLookup = (tenantId: string) => Promise<{ url: string; events: string[] | null } | null>

export function endpointLookup(db: Database): EndpointLookup {
  return async (tenantId) => {
    const [row] = await db.select({ url: webhookEndpoints.url, events: webhookEndpoints.events }).from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, tenantId))
    return row ?? null
  }
}

/**
 * Returns the delivery id, or null when the tenant has no matching endpoint, or when `eventId` was
 * already enqueued (a replayed outbox row, review M6).
 */
export async function enqueueEvent(db: Database, lookup: EndpointLookup, tenantId: string, type: EventType, data: Record<string, unknown>, eventId?: string): Promise<number | null> {
  const endpoint = await lookup(tenantId)
  if (!endpoint) return null
  if (endpoint.events && !endpoint.events.includes(type)) return null
  const envelope = buildEnvelope(tenantId, type, data, new Date(), eventId)
  const [row] = await db
    .insert(webhookDeliveries)
    .values({ tenantId, eventId: envelope.id, eventType: type, body: JSON.stringify(envelope), url: endpoint.url })
    .onConflictDoNothing({ target: webhookDeliveries.eventId })
    .returning({ id: webhookDeliveries.id })
  return row?.id ?? null
}
