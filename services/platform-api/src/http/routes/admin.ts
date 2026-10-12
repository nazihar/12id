/**
 * Operator routes: tenants, API keys and the cross-tenant views of the Phase 4 console. Two callers:
 * the console (console token + operator role + actor) and the break-glass `x-admin-token` over an
 * SSH tunnel. The edge answers 404 for /admin/*; both callers are audited (audit.ts).
 */
import { type SQL, and, desc, eq, inArray, like, ne, or } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { AgentClient } from '../../agent-client.ts'
import { API_KEY_PREFIX, generateSecret, hashSecret, lookupPrefix } from '../../auth/tokens.ts'
import type { Database } from '../../db/client.ts'
import { DELIVERY_STATUSES, apiKeys, consoleAudit, tenants, webhookDeliveries } from '../../db/schema.ts'
import { requireOperator } from '../auth.ts'
import { notFound } from '../errors.ts'
import { containsI, createdBetween, createdRange, listPage, many, newestFirst, oneOrMany, pageOf, pageQuery, searchQuery } from '../list.ts'
import { AUDIT_EVENT_METHOD, AUDIT_KINDS, type AuditKind } from './audit-events.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'
import { activeRevokedByTenant, deadDeliveriesByTenant, exchangeActivityByTenant } from './stats.ts'
import { deliveryFilters, deliveryListQuery, deliveryView, toDeliveryView } from './webhook.ts'

export interface AdminDeps {
  db: Database
  agent: AgentClient
  adminToken: string
  consoleToken?: string
}

const tags = ['admin', CONSOLE_ONLY_TAG]
const tenantView = z.object({ id: z.string(), name: z.string(), status: z.string(), did: z.string().nullable(), agentTenantId: z.string(), lastError: z.string().nullable(), rateLimitPerMin: z.number().int().nullable(), createdAt: z.iso.datetime() })
const errorBody = z.object({ error: z.string(), reason: z.string() })
const stateCounts = z.record(z.string(), z.number().int())
const activeRevoked = z.object({ active: z.number().int(), revoked: z.number().int() })
const overviewView = z.object({
  tenant: tenantView,
  connections: stateCounts,
  credentials: stateCounts,
  proofs: stateCounts,
  wallets: activeRevoked,
  apiKeys: activeRevoked,
  deadDeliveries: z.number().int(),
  /** Latest update of any connection, credential or proof exchange. */
  lastActivityAt: z.iso.datetime().nullable(),
})
const auditView = z.object({
  id: z.number().int(),
  at: z.iso.datetime(),
  actor: z.string(),
  /** The actor's email when it acted; null on rows written before it was kept. */
  actorLabel: z.string().nullable(),
  role: z.string(),
  tenantId: z.string().nullable(),
  /** The HTTP method of a change, or `EVENT` for a sign-in, an account change or an export the console reported. */
  method: z.string(),
  /** The route pattern of a change, or the event's type (`auth.sign_in`). */
  route: z.string(),
  statusCode: z.number().int(),
  requestId: z.string(),
  /** Why, for an operator's erasure or a reveal of personal data (Phase 7 H1). */
  reason: z.string().nullable(),
  /** Route parameters and request body of a change, secrets and personal data replaced (review L10). */
  changes: z.record(z.string(), z.unknown()).nullable(),
})

async function onboard(deps: AdminDeps, tenantId: string, agentTenantId: string) {
  try {
    const result = await deps.agent.onboardTenant(agentTenantId)
    const ready = result.status === 'ready'
    await deps.db.update(tenants).set({ status: ready ? 'ready' : 'provisioning', did: result.did, lastError: ready ? null : result.lastError ?? `agent status ${result.status}`, updatedAt: new Date() }).where(eq(tenants.id, tenantId))
  } catch (error) {
    await deps.db.update(tenants).set({ status: 'failed', lastError: (error as Error).message.slice(0, 500), updatedAt: new Date() }).where(eq(tenants.id, tenantId))
  }
}

const view = (row: typeof tenants.$inferSelect) => ({ id: row.id, name: row.name, status: row.status, did: row.did, agentTenantId: row.agentTenantId, lastError: row.lastError, rateLimitPerMin: row.rateLimitPerMin, createdAt: row.createdAt.toISOString() })

export const adminRoutes = (deps: AdminDeps): FastifyPluginAsyncZod => async (app) => {
  app.addHook('onRequest', requireOperator(deps.adminToken, deps.consoleToken))

  app.post('/admin/tenants', { schema: { tags, body: z.object({ name: z.string().min(1).max(200) }), response: { 201: tenantView } } }, async (request, reply) => {
    // Onboarding writes the ledger through the endorser (Phase 2 A3); ~0.5 s on staging, run inline.
    const created = await deps.agent.createTenant(request.body.name)
    const [row] = await deps.db.insert(tenants).values({ name: request.body.name, agentTenantId: created.tenantId }).returning()
    await onboard(deps, row.id, created.tenantId)
    const [fresh] = await deps.db.select().from(tenants).where(eq(tenants.id, row.id))
    return reply.code(201).send(view(fresh))
  })

  app.get('/admin/tenants', { schema: { tags, response: { 200: z.array(tenantView) } } }, async () => {
    const rows = await deps.db.select().from(tenants).orderBy(desc(tenants.createdAt))
    return rows.map(view)
  })

  app.get('/admin/tenants/:id', { schema: { tags, params: z.object({ id: z.uuid() }), response: { 200: tenantView, 404: errorBody } } }, async (request) => {
    const [row] = await deps.db.select().from(tenants).where(eq(tenants.id, request.params.id))
    if (!row) throw notFound('tenant')
    return view(row)
  })

  // Review M4: raise (or lower) one tenant's per-API-key limit; null returns it to the configured default.
  app.patch(
    '/admin/tenants/:id',
    {
      schema: {
        tags,
        summary: 'Change tenant settings',
        description: '`rateLimitPerMin`: requests per minute per API key for this tenant (0 = no limit); null = the platform default (RATE_LIMIT_API_KEY_PER_MIN).',
        params: z.object({ id: z.uuid() }),
        body: z.object({ rateLimitPerMin: z.number().int().min(0).max(100_000).nullable() }),
        response: { 200: tenantView, 404: errorBody },
      },
    },
    async (request) => {
      const [row] = await deps.db.update(tenants).set({ rateLimitPerMin: request.body.rateLimitPerMin, updatedAt: new Date() }).where(eq(tenants.id, request.params.id)).returning()
      if (!row) throw notFound('tenant')
      return view(row)
    }
  )

  app.post('/admin/tenants/:id/onboard', { schema: { tags, params: z.object({ id: z.uuid() }), response: { 200: tenantView, 404: errorBody } } }, async (request) => {
    const [row] = await deps.db.select().from(tenants).where(eq(tenants.id, request.params.id))
    if (!row) throw notFound('tenant')
    await onboard(deps, row.id, row.agentTenantId)
    const [fresh] = await deps.db.select().from(tenants).where(eq(tenants.id, row.id))
    return view(fresh)
  })

  app.post(
    '/admin/tenants/:id/api-keys',
    { schema: { tags, params: z.object({ id: z.uuid() }), body: z.object({ label: z.string().min(1).max(100) }), response: { 201: z.object({ id: z.string(), label: z.string(), apiKey: z.string(), createdAt: z.iso.datetime() }), 404: errorBody } } },
    async (request, reply) => {
      const [tenant] = await deps.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, request.params.id))
      if (!tenant) throw notFound('tenant')
      const apiKey = generateSecret(API_KEY_PREFIX)
      // Flagged as an operator's key in the tenant's list (Phase 7 H1).
      const [row] = await deps.db.insert(apiKeys).values({ tenantId: tenant.id, prefix: lookupPrefix(apiKey), keyHash: hashSecret(apiKey), label: request.body.label, createdBy: request.operator?.actor ?? 'admin-token', createdByRole: 'operator' }).returning()
      // The plaintext key exists only in this response.
      return reply.code(201).send({ id: row.id, label: row.label, apiKey, createdAt: row.createdAt.toISOString() })
    }
  )

  app.get('/admin/tenants/:id/api-keys', { schema: { tags, params: z.object({ id: z.uuid() }), response: { 200: z.array(z.object({ id: z.string(), label: z.string(), prefix: z.string(), createdAt: z.iso.datetime(), lastUsedAt: z.iso.datetime().nullable(), revokedAt: z.iso.datetime().nullable() })) } } }, async (request) => {
    const rows = await deps.db.select().from(apiKeys).where(eq(apiKeys.tenantId, request.params.id)).orderBy(desc(apiKeys.createdAt))
    return rows.map((k) => ({ id: k.id, label: k.label, prefix: k.prefix, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null }))
  })

  app.delete('/admin/api-keys/:id', { schema: { tags, params: z.object({ id: z.uuid() }), response: { 200: z.object({ revoked: z.boolean() }), 404: errorBody } } }, async (request) => {
    const rows = await deps.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, request.params.id)).returning({ id: apiKeys.id })
    if (rows.length === 0) throw notFound('api key')
    return { revoked: true }
  })

  app.get(
    '/admin/overview',
    {
      schema: {
        tags,
        summary: 'Per-tenant activity for the operator console',
        description: 'Tenants newest first, paged. `q` matches the tenant name.',
        querystring: pageQuery.extend(searchQuery.shape).extend({ status: z.enum(['provisioning', 'ready', 'failed']).optional() }),
        response: { 200: pageOf(overviewView) },
      },
    },
    async (request) => {
      const { q, status } = request.query
      const filters: SQL[] = []
      if (q) filters.push(containsI(tenants.name, q))
      if (status) filters.push(eq(tenants.status, status))
      const page = await listPage(deps.db, { table: tenants, where: filters, ...request.query }, (where, limit, offset) =>
        deps.db.select().from(tenants).where(where).orderBy(desc(tenants.createdAt), desc(tenants.id)).limit(limit).offset(offset)
      )
      // The aggregates cover this page's tenants only.
      const ids = page.items.map((row) => row.id)
      const [activity, wallets, keys, deadDeliveries] = ids.length
        ? await Promise.all([exchangeActivityByTenant(deps.db, ids), activeRevokedByTenant(deps.db, 'wallets', ids), activeRevokedByTenant(deps.db, 'api_keys', ids), deadDeliveriesByTenant(deps.db, ids)])
        : [new Map(), new Map(), new Map(), new Map()]
      const items = page.items.map((row) => {
        const entry = activity.get(row.id)
        return {
          tenant: view(row),
          connections: entry?.connections ?? {},
          credentials: entry?.credentials ?? {},
          proofs: entry?.proofs ?? {},
          wallets: wallets.get(row.id) ?? { active: 0, revoked: 0 },
          apiKeys: keys.get(row.id) ?? { active: 0, revoked: 0 },
          deadDeliveries: deadDeliveries.get(row.id) ?? 0,
          lastActivityAt: entry?.last?.toISOString() ?? null,
        }
      })
      return { ...page, items }
    }
  )

  app.get(
    '/admin/webhook-deliveries',
    {
      schema: {
        tags,
        summary: 'Webhook deliveries across tenants',
        description: 'Newest first, paged. The body is not included.',
        querystring: deliveryListQuery.extend({ tenantId: z.uuid().optional() }),
        response: { 200: pageOf(deliveryView.extend({ tenantId: z.string() })) },
      },
    },
    async (request) => {
      const filters = deliveryFilters(request.query)
      if (request.query.tenantId) filters.push(eq(webhookDeliveries.tenantId, request.query.tenantId))
      const page = await listPage(deps.db, { table: webhookDeliveries, where: filters, ...request.query }, (where, limit, offset) =>
        deps.db.select().from(webhookDeliveries).where(where).orderBy(...newestFirst(webhookDeliveries.createdAt, webhookDeliveries.id)).limit(limit).offset(offset)
      )
      return { ...page, items: page.items.map((row) => ({ ...toDeliveryView(row), tenantId: row.tenantId })) }
    }
  )

  app.get(
    '/admin/audit',
    {
      schema: {
        tags,
        summary: 'Console audit log',
        description:
          'Newest first, paged. Each change carries its route parameters and request body, with secrets and personal data replaced. Sign-ins, account changes and exports are rows with method `EVENT` and their type as the route. `kind` keeps one family: `change` (calls that went through this API), `sign-in`, `account` or `export`. `q` matches the route pattern or event type, the actor id or the actor label (email), or any of the `qActor` ids (the console resolves names and emails to account ids); `actor` restricts to one or more actor ids.',
        querystring: pageQuery
          .extend(createdRange.shape)
          .extend(searchQuery.shape)
          .extend({ tenantId: z.uuid().optional(), kind: z.enum(Object.keys(AUDIT_KINDS) as [AuditKind, ...AuditKind[]]).optional(), actor: oneOrMany(z.string().min(1).max(200)), qActor: oneOrMany(z.string().min(1).max(200)) }),
        response: { 200: pageOf(auditView) },
      },
    },
    async (request) => {
      const { tenantId, q, kind } = request.query
      const actors = many(request.query.actor)
      const filters: SQL[] = createdBetween(consoleAudit.at, request.query)
      if (tenantId) filters.push(eq(consoleAudit.tenantId, tenantId))
      if (kind) {
        const prefix = AUDIT_KINDS[kind]
        filters.push(prefix === null ? ne(consoleAudit.method, AUDIT_EVENT_METHOD) : and(eq(consoleAudit.method, AUDIT_EVENT_METHOD), like(consoleAudit.route, `${prefix}%`))!)
      }
      if (actors.length) filters.push(inArray(consoleAudit.actor, actors))
      const qActors = many(request.query.qActor)
      if (q) filters.push(or(containsI(consoleAudit.route, q), containsI(consoleAudit.actor, q), containsI(consoleAudit.actorLabel, q), ...(qActors.length ? [inArray(consoleAudit.actor, qActors)] : []))!)
      const page = await listPage(deps.db, { table: consoleAudit, where: filters, ...request.query }, (where, limit, offset) =>
        deps.db.select().from(consoleAudit).where(where).orderBy(desc(consoleAudit.at), desc(consoleAudit.id)).limit(limit).offset(offset)
      )
      return {
        ...page,
        items: page.items.map((row) => ({ id: row.id, at: row.at.toISOString(), actor: row.actor, actorLabel: row.actorLabel, role: row.role, tenantId: row.tenantId, method: row.method, route: row.route, statusCode: row.statusCode, requestId: row.requestId, reason: row.reason, changes: row.changes ?? null })),
      }
    }
  )
}
