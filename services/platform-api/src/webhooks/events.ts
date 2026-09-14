/**
 * Event envelopes and the enqueue step. A delivery row is written only when the tenant has a
 * webhook endpoint that subscribes to the type; the body is serialised once here so every retry
 * signs byte-identical content.
 */
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'

import type { Database } from '../db/client.ts'
import { webhookDeliveries, webhookEndpoints } from '../db/schema.ts'

export const EVENT_TYPES = ['connection.state_changed', 'credential.state_changed', 'proof.state_changed', 'wallet.sync_requested'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export interface EventEnvelope {
  id: string
  type: EventType
  createdAt: string
  tenantId: string
  data: Record<string, unknown>
}

export function buildEnvelope(tenantId: string, type: EventType, data: Record<string, unknown>, now = new Date()): EventEnvelope {
  return { id: randomUUID(), type, createdAt: now.toISOString(), tenantId, data }
}

export type EndpointLookup = (tenantId: string) => Promise<{ url: string; events: string[] | null } | null>

export function endpointLookup(db: Database): EndpointLookup {
  return async (tenantId) => {
    const [row] = await db.select({ url: webhookEndpoints.url, events: webhookEndpoints.events }).from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, tenantId))
    return row ?? null
  }
}

/** Returns the delivery id, or null when the tenant has no matching endpoint. */
export async function enqueueEvent(db: Database, lookup: EndpointLookup, tenantId: string, type: EventType, data: Record<string, unknown>): Promise<number | null> {
  const endpoint = await lookup(tenantId)
  if (!endpoint) return null
  if (endpoint.events && !endpoint.events.includes(type)) return null
  const envelope = buildEnvelope(tenantId, type, data)
  const [row] = await db
    .insert(webhookDeliveries)
    .values({ tenantId, eventId: envelope.id, eventType: type, body: JSON.stringify(envelope), url: endpoint.url })
    .returning({ id: webhookDeliveries.id })
  return row?.id ?? null
}
