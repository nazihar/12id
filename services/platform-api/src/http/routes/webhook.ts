/**
 * Webhook endpoint configuration and delivery log (P4/P7), per tenant. Reads take an API key or the
 * console; changing the endpoint, its secret, or retrying a delivery is console only (review K1), so
 * a leaked API key cannot point signed events at another host.
 */
import { randomBytes } from 'node:crypto'

import { type SQL, and, desc, eq, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { Database } from '../../db/client.ts'
import { DELIVERY_STATUSES, webhookDeliveries, webhookEndpoints } from '../../db/schema.ts'
import { EVENT_TYPES } from '../../webhooks/events.ts'
import { type TenantContext, requireConsolePrincipal } from '../auth.ts'
import { notFound } from '../errors.ts'
import { createdBetween, createdRange, listPage, pageOf, pageQuery } from '../list.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'

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

/** Delivery list filters, shared with the operator's cross-tenant list (Phase 4 C9). */
export const deliveryListQuery = pageQuery.extend(createdRange.shape).extend({ status: z.enum(DELIVERY_STATUSES).optional(), eventType: z.enum(EVENT_TYPES).optional() })
export function deliveryFilters(query: z.infer<typeof deliveryListQuery>): SQL[] {
  const filters = createdBetween(webhookDeliveries.createdAt, query)
  if (query.status) filters.push(eq(webhookDeliveries.status, query.status))
  if (query.eventType) filters.push(eq(webhookDeliveries.eventType, query.eventType))
  return filters
}

const httpsUrl = z.url().refine((u) => u.startsWith('https://'), 'webhook URLs must use https')
const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`

export const webhookRoutes = (deps: { db: Database }): FastifyPluginAsyncZod => async (app) => {
  const tenant = (request: { tenant?: TenantContext }) => request.tenant as TenantContext
  const editor = (request: { tenant?: TenantContext }) => requireConsolePrincipal(request.tenant as TenantContext, 'the webhook endpoint is managed from the console')
  const writeTags = ['webhooks', CONSOLE_ONLY_TAG]
  const endpoint = (row: typeof webhookEndpoints.$inferSelect) => ({ url: row.url, events: row.events as z.infer<typeof endpointView>['events'], createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })
  const delivery = toDeliveryView

  app.put(
    '/v1/webhook',
    {
      schema: {
        tags: writeTags,
        summary: 'Set the webhook endpoint',
        description: 'One endpoint per tenant. The signing `secret` is returned only when it is created or rotated. Events are POSTed as `{ id, type, createdAt, tenantId, data }` with `X-12id-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. During a secret rotation the header carries one `v1` per secret for 24 h; accept a match on any of them. Answer 2xx within 10 s; failures are retried with exponential backoff (12 attempts over about 2.5 hours) and then dead-lettered. Each attempt goes to the URL set at that moment.',
        body: z.object({ url: httpsUrl, events: z.array(z.enum(EVENT_TYPES)).min(1).optional() }),
        response: { 200: endpointView.extend({ secret: z.string().optional() }), 403: errorBody },
      },
    },
    async (request) => {
      const t = editor(request)
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

  // No idempotent replay: it could hand back a secret a later rotation replaced; rotating again is harmless.
  // The replaced secret keeps signing alongside the new one for 24 h (review M9), so receivers can switch
  // without rejecting deliveries. A second rotation inside that window drops the oldest secret.
  app.post(
    '/v1/webhook/rotate-secret',
    {
      schema: {
        tags: writeTags,
        summary: 'Rotate the signing secret',
        description: 'For 24 hours after a rotation every delivery carries two signatures, `v1=<new>,v1=<previous>`, so a receiver still on the previous secret keeps accepting them. Switch within that window.',
        response: { 200: z.object({ secret: z.string() }), 403: errorBody, 404: errorBody },
      },
      config: { idempotency: false },
    },
    async (request) => {
      const t = editor(request)
      const secret = newSecret()
      const now = new Date()
      const rows = await deps.db
        .update(webhookEndpoints)
        .set({ secret, previousSecret: sql`${webhookEndpoints.secret}`, rotatedAt: now, updatedAt: now })
        .where(eq(webhookEndpoints.tenantId, t.id))
        .returning({ tenantId: webhookEndpoints.tenantId })
      if (rows.length === 0) throw notFound('webhook endpoint')
      return { secret }
    }
  )

  app.delete('/v1/webhook', { schema: { tags: writeTags, summary: 'Remove the webhook endpoint', response: { 200: z.object({ deleted: z.boolean() }), 403: errorBody, 404: errorBody } } }, async (request) => {
    const rows = await deps.db.delete(webhookEndpoints).where(eq(webhookEndpoints.tenantId, editor(request).id)).returning({ tenantId: webhookEndpoints.tenantId })
    if (rows.length === 0) throw notFound('webhook endpoint')
    return { deleted: true }
  })

  app.get(
    '/v1/webhook/deliveries',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'List deliveries',
        description: 'Newest first (`createdAt` descending), paged with `page` and `pageSize`.',
        querystring: deliveryListQuery,
        response: { 200: pageOf(deliveryView) },
      },
    },
    async (request) => {
      const filters = [eq(webhookDeliveries.tenantId, tenant(request).id), ...deliveryFilters(request.query)]
      const page = await listPage(deps.db, { table: webhookDeliveries, where: filters, ...request.query }, (where, limit, offset) =>
        deps.db.select().from(webhookDeliveries).where(where).orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id)).limit(limit).offset(offset)
      )
      return { ...page, items: page.items.map(delivery) }
    }
  )

  // The body carries credential attributes, so console reads of it are audited.
  app.get('/v1/webhook/deliveries/:id', { config: { auditRead: true }, schema: { tags: ['webhooks'], summary: 'Get a delivery, including its body', params: z.object({ id: z.coerce.number().int() }), response: { 200: deliveryView.extend({ body: z.string() }), 404: errorBody } } }, async (request) => {
    const [row] = await deps.db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.tenantId, tenant(request).id), eq(webhookDeliveries.id, request.params.id)))
    if (!row) throw notFound('delivery')
    return { ...delivery(row), body: row.body }
  })

  app.post('/v1/webhook/deliveries/:id/retry', { schema: { tags: writeTags, summary: 'Retry a dead or pending delivery now', params: z.object({ id: z.coerce.number().int() }), response: { 200: deliveryView, 403: errorBody, 404: errorBody } } }, async (request) => {
    const t = editor(request)
    const [row] = await deps.db
      .update(webhookDeliveries)
      .set({ status: 'pending', nextAttemptAt: new Date() })
      .where(and(eq(webhookDeliveries.tenantId, t.id), eq(webhookDeliveries.id, request.params.id)))
      .returning()
    if (!row) throw notFound('delivery')
    return delivery(row)
  })
}
