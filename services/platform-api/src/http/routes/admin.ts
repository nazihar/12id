/**
 * Operator routes: tenants, API keys and the cross-tenant views of the Phase 4 console. Two callers:
 * the console (console token + operator role + actor) and the break-glass `x-admin-token` over an
 * SSH tunnel. The edge answers 404 for /admin/*; both callers are audited (audit.ts).
 */
import { type SQL, and, desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { AgentClient } from '../../agent-client.ts'
import { API_KEY_PREFIX, generateSecret, hashSecret, lookupPrefix } from '../../auth/tokens.ts'
import type { Database } from '../../db/client.ts'
import { DELIVERY_STATUSES, apiKeys, consoleAudit, tenants, webhookDeliveries } from '../../db/schema.ts'
import { requireOperator } from '../auth.ts'
import { notFound } from '../errors.ts'
import { CONSOLE_ONLY_TAG } from './console.ts'
import { activeRevokedByTenant, deadDeliveriesByTenant, exchangeActivityByTenant } from './stats.ts'
import { deliveryView, toDeliveryView } from './webhook.ts'

export interface AdminDeps {
  db: Database
  agent: AgentClient
  adminToken: string
  consoleToken?: string
}

const tags = ['admin', CONSOLE_ONLY_TAG]
const tenantView = z.object({ id: z.string(), name: z.string(), status: z.string(), did: z.string().nullable(), agentTenantId: z.string(), lastError: z.string().nullable(), createdAt: z.iso.datetime() })
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
const auditView = z.object({ id: z.number().int(), at: z.iso.datetime(), actor: z.string(), role: z.string(), tenantId: z.string().nullable(), method: z.string(), route: z.string(), statusCode: z.number().int(), requestId: z.string() })

async function onboard(deps: AdminDeps, tenantId: string, agentTenantId: string) {
  try {
    const result = await deps.agent.onboardTenant(agentTenantId)
    const ready = result.status === 'ready'
    await deps.db.update(tenants).set({ status: ready ? 'ready' : 'provisioning', did: result.did, lastError: ready ? null : result.lastError ?? `agent status ${result.status}`, updatedAt: new Date() }).where(eq(tenants.id, tenantId))
  } catch (error) {
    await deps.db.update(tenants).set({ status: 'failed', lastError: (error as Error).message.slice(0, 500), updatedAt: new Date() }).where(eq(tenants.id, tenantId))
  }
}

const view = (row: typeof tenants.$inferSelect) => ({ id: row.id, name: row.name, status: row.status, did: row.did, agentTenantId: row.agentTenantId, lastError: row.lastError, createdAt: row.createdAt.toISOString() })

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
      const [row] = await deps.db.insert(apiKeys).values({ tenantId: tenant.id, prefix: lookupPrefix(apiKey), keyHash: hashSecret(apiKey), label: request.body.label }).returning()
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

  app.get('/admin/overview', { schema: { tags, summary: 'Per-tenant activity for the operator console', response: { 200: z.array(overviewView) } } }, async () => {
    const [tenantRows, activity, wallets, keys, deadDeliveries] = await Promise.all([
      deps.db.select().from(tenants).orderBy(desc(tenants.createdAt)),
      exchangeActivityByTenant(deps.db),
      activeRevokedByTenant(deps.db, 'wallets'),
      activeRevokedByTenant(deps.db, 'api_keys'),
      deadDeliveriesByTenant(deps.db),
    ])
    return tenantRows.map((row) => {
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
  })

  app.get(
    '/admin/webhook-deliveries',
    {
      schema: {
        tags,
        summary: 'Webhook deliveries across tenants',
        querystring: z.object({ status: z.enum(DELIVERY_STATUSES).optional(), tenantId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: z.array(deliveryView.extend({ tenantId: z.string() })) },
      },
    },
    async (request) => {
      const filters: SQL[] = []
      if (request.query.status) filters.push(eq(webhookDeliveries.status, request.query.status))
      if (request.query.tenantId) filters.push(eq(webhookDeliveries.tenantId, request.query.tenantId))
      const rows = await deps.db.select().from(webhookDeliveries).where(and(...filters)).orderBy(desc(webhookDeliveries.id)).limit(request.query.limit)
      return rows.map((row) => ({ ...toDeliveryView(row), tenantId: row.tenantId }))
    }
  )

  app.get(
    '/admin/audit',
    {
      schema: {
        tags,
        summary: 'Console audit log',
        querystring: z.object({ tenantId: z.uuid().optional(), actor: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
        response: { 200: z.array(auditView) },
      },
    },
    async (request) => {
      const filters: SQL[] = []
      if (request.query.tenantId) filters.push(eq(consoleAudit.tenantId, request.query.tenantId))
      if (request.query.actor) filters.push(eq(consoleAudit.actor, request.query.actor))
      const rows = await deps.db.select().from(consoleAudit).where(and(...filters)).orderBy(desc(consoleAudit.id)).limit(request.query.limit)
      return rows.map((row) => ({ id: row.id, at: row.at.toISOString(), actor: row.actor, role: row.role, tenantId: row.tenantId, method: row.method, route: row.route, statusCode: row.statusCode, requestId: row.requestId }))
    }
  )
}
