/** Webhook endpoint configuration and delivery log (P4/P7), per tenant. */
import { randomBytes } from 'node:crypto'

import { and, desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Database } from '../../db/client.ts'
import { DELIVERY_STATUSES, webhookDeliveries, webhookEndpoints } from '../../db/schema.ts'
import { EVENT_TYPES } from '../../webhooks/events.ts'
import type { TenantContext } from '../auth.ts'
import { notFound } from '../errors.ts'

const errorBody = z.object({ error: z.string(), reason: z.string() })
const endpointView = z.object({ url: z.string(), events: z.array(z.enum(EVENT_TYPES)).nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() })
export const deliveryView = z.object({
  id: z.number().int(),
  eventId: z.string(),
  eventType: z.string(),
  status: z.enum(DELIVERY_STATUSES),
  attempts: z.number().int(),
  nextAttemptAt: z.iso.datetime(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
})

export const toDeliveryView = (row: typeof webhookDeliveries.$inferSelect) => ({
  id: row.id,
  eventId: row.eventId,
  eventType: row.eventType,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.nextAttemptAt.toISOString(),
  lastStatusCode: row.lastStatusCode,
  lastError: row.lastError,
  createdAt: row.createdAt.toISOString(),
  deliveredAt: row.deliveredAt?.toISOString() ?? null,
})

const httpsUrl = z.url().refine((u) => u.startsWith('https://'), 'webhook URLs must use https')
const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`

export const webhookRoutes = (deps: { db: Database }): FastifyPluginAsyncZod => async (app) => {
  const tenant = (request: { tenant?: TenantContext }) => request.tenant as TenantContext
  const endpoint = (row: typeof webhookEndpoints.$inferSelect) => ({ url: row.url, events: row.events as z.infer<typeof endpointView>['events'], createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })
  const delivery = toDeliveryView

  app.put(
    '/v1/webhook',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Set the webhook endpoint',
        description: 'One endpoint per tenant. The signing `secret` is returned only when it is created or rotated. Events are POSTed as `{ id, type, createdAt, tenantId, data }` with `X-12id-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. Answer 2xx within 10 s; failures are retried with exponential backoff (about 12 attempts over a day) and then dead-lettered.',
        body: z.object({ url: httpsUrl, events: z.array(z.enum(EVENT_TYPES)).min(1).optional() }),
        response: { 200: endpointView.extend({ secret: z.string().optional() }) },
      },
    },
    async (request) => {
      const t = tenant(request)
      const [existing] = await deps.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, t.id))
      if (existing) {
        const [row] = await deps.db.update(webhookEndpoints).set({ url: request.body.url, events: request.body.events ?? null, updatedAt: new Date() }).where(eq(webhookEndpoints.tenantId, t.id)).returning()
        return endpoint(row)
      }
      const secret = newSecret()
      const [row] = await deps.db.insert(webhookEndpoints).values({ tenantId: t.id, url: request.body.url, secret, events: request.body.events ?? null }).returning()
      return { ...endpoint(row), secret }
    }
  )

  app.get('/v1/webhook', { schema: { tags: ['webhooks'], summary: 'Get the webhook endpoint', response: { 200: endpointView, 404: errorBody } } }, async (request) => {
    const [row] = await deps.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.tenantId, tenant(request).id))
    if (!row) throw notFound('webhook endpoint')
    return endpoint(row)
  })

  app.post('/v1/webhook/rotate-secret', { schema: { tags: ['webhooks'], summary: 'Rotate the signing secret', response: { 200: z.object({ secret: z.string() }), 404: errorBody } } }, async (request) => {
    const secret = newSecret()
    const rows = await deps.db.update(webhookEndpoints).set({ secret, updatedAt: new Date() }).where(eq(webhookEndpoints.tenantId, tenant(request).id)).returning({ tenantId: webhookEndpoints.tenantId })
    if (rows.length === 0) throw notFound('webhook endpoint')
    return { secret }
  })

  app.delete('/v1/webhook', { schema: { tags: ['webhooks'], summary: 'Remove the webhook endpoint', response: { 200: z.object({ deleted: z.boolean() }), 404: errorBody } } }, async (request) => {
    const rows = await deps.db.delete(webhookEndpoints).where(eq(webhookEndpoints.tenantId, tenant(request).id)).returning({ tenantId: webhookEndpoints.tenantId })
    if (rows.length === 0) throw notFound('webhook endpoint')
    return { deleted: true }
  })

  app.get(
    '/v1/webhook/deliveries',
    { schema: { tags: ['webhooks'], summary: 'List deliveries', querystring: z.object({ status: z.enum(DELIVERY_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), response: { 200: z.array(deliveryView) } } },
    async (request) => {
      const filters = [eq(webhookDeliveries.tenantId, tenant(request).id)]
      if (request.query.status) filters.push(eq(webhookDeliveries.status, request.query.status))
      const rows = await deps.db.select().from(webhookDeliveries).where(and(...filters)).orderBy(desc(webhookDeliveries.id)).limit(request.query.limit)
      return rows.map(delivery)
    }
  )

  // The body carries credential attributes, so console reads of it are audited.
  app.get('/v1/webhook/deliveries/:id', { config: { auditRead: true }, schema: { tags: ['webhooks'], summary: 'Get a delivery, including its body', params: z.object({ id: z.coerce.number().int() }), response: { 200: deliveryView.extend({ body: z.string() }), 404: errorBody } } }, async (request) => {
    const [row] = await deps.db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.tenantId, tenant(request).id), eq(webhookDeliveries.id, request.params.id)))
    if (!row) throw notFound('delivery')
    return { ...delivery(row), body: row.body }
  })

  app.post('/v1/webhook/deliveries/:id/retry', { schema: { tags: ['webhooks'], summary: 'Retry a dead or pending delivery now', params: z.object({ id: z.coerce.number().int() }), response: { 200: deliveryView, 404: errorBody } } }, async (request) => {
    const [row] = await deps.db
      .update(webhookDeliveries)
      .set({ status: 'pending', nextAttemptAt: new Date() })
      .where(and(eq(webhookDeliveries.tenantId, tenant(request).id), eq(webhookDeliveries.id, request.params.id)))
      .returning()
    if (!row) throw notFound('delivery')
    return delivery(row)
  })
}
