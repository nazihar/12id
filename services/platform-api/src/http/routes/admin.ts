/**
 * Operator bootstrap (P3): tenants and API keys, behind `x-admin-token`. The edge answers 404
 * for /admin/*, so these are reachable only on the VM (SSH tunnel) until the Phase 4 admin UI.
 */
import { desc, eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import type { AgentClient } from '../../agent-client.ts'
import { API_KEY_PREFIX, generateSecret, hashSecret, lookupPrefix } from '../../auth/tokens.ts'
import type { Database } from '../../db/client.ts'
import { apiKeys, tenants } from '../../db/schema.ts'
import { requireAdminToken } from '../auth.ts'
import { notFound } from '../errors.ts'

export interface AdminDeps {
  db: Database
  agent: AgentClient
  adminToken: string
}

const tenantView = z.object({ id: z.string(), name: z.string(), status: z.string(), did: z.string().nullable(), agentTenantId: z.string(), lastError: z.string().nullable(), createdAt: z.iso.datetime() })
const errorBody = z.object({ error: z.string(), reason: z.string() })

async function onboard(deps: AdminDeps, tenantId: string, agentTenantId: string) {
  try {
    const result = await deps.agent.onboardTenant(agentTenantId)
    const ready = result.status === 'ready'
    await deps.db.update(tenants).set({ status: ready ? 'ready' : 'provisioning', did: result.did, lastError: ready ? null : result.lastError ?? `agent status ${result.status}`, updatedAt: new Date() }).where(eq(tenants.id, tenantId))
  } catch (error) {
    await deps.db.update(tenants).set({ status: 'failed', lastError: (error as Error).message.slice(0, 500), updatedAt: new Date() }).where(eq(tenants.id, tenantId))
  }
}

export const adminRoutes = (deps: AdminDeps): FastifyPluginAsyncZod => async (app) => {
  app.addHook('onRequest', requireAdminToken(deps.adminToken))

  const view = (row: typeof tenants.$inferSelect) => ({ id: row.id, name: row.name, status: row.status, did: row.did, agentTenantId: row.agentTenantId, lastError: row.lastError, createdAt: row.createdAt.toISOString() })

  app.post('/admin/tenants', { schema: { tags: ['admin'], body: z.object({ name: z.string().min(1).max(200) }), response: { 201: tenantView } } }, async (request, reply) => {
    // Onboarding writes the ledger through the endorser (Phase 2 A3); ~0.5 s on staging, run inline.
    const created = await deps.agent.createTenant(request.body.name)
    const [row] = await deps.db.insert(tenants).values({ name: request.body.name, agentTenantId: created.tenantId }).returning()
    await onboard(deps, row.id, created.tenantId)
    const [fresh] = await deps.db.select().from(tenants).where(eq(tenants.id, row.id))
    return reply.code(201).send(view(fresh))
  })

  app.get('/admin/tenants', { schema: { tags: ['admin'], response: { 200: z.array(tenantView) } } }, async () => {
    const rows = await deps.db.select().from(tenants).orderBy(desc(tenants.createdAt))
    return rows.map(view)
  })

  app.post('/admin/tenants/:id/onboard', { schema: { tags: ['admin'], params: z.object({ id: z.uuid() }), response: { 200: tenantView, 404: errorBody } } }, async (request) => {
    const [row] = await deps.db.select().from(tenants).where(eq(tenants.id, request.params.id))
    if (!row) throw notFound('tenant')
    await onboard(deps, row.id, row.agentTenantId)
    const [fresh] = await deps.db.select().from(tenants).where(eq(tenants.id, row.id))
    return view(fresh)
  })

  app.post(
    '/admin/tenants/:id/api-keys',
    { schema: { tags: ['admin'], params: z.object({ id: z.uuid() }), body: z.object({ label: z.string().min(1).max(100) }), response: { 201: z.object({ id: z.string(), label: z.string(), apiKey: z.string(), createdAt: z.iso.datetime() }), 404: errorBody } } },
    async (request, reply) => {
      const [tenant] = await deps.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, request.params.id))
      if (!tenant) throw notFound('tenant')
      const apiKey = generateSecret(API_KEY_PREFIX)
      const [row] = await deps.db.insert(apiKeys).values({ tenantId: tenant.id, prefix: lookupPrefix(apiKey), keyHash: hashSecret(apiKey), label: request.body.label }).returning()
      // The plaintext key exists only in this response.
      return reply.code(201).send({ id: row.id, label: row.label, apiKey, createdAt: row.createdAt.toISOString() })
    }
  )

  app.get('/admin/tenants/:id/api-keys', { schema: { tags: ['admin'], params: z.object({ id: z.uuid() }), response: { 200: z.array(z.object({ id: z.string(), label: z.string(), prefix: z.string(), createdAt: z.iso.datetime(), lastUsedAt: z.iso.datetime().nullable(), revokedAt: z.iso.datetime().nullable() })) } } }, async (request) => {
    const rows = await deps.db.select().from(apiKeys).where(eq(apiKeys.tenantId, request.params.id)).orderBy(desc(apiKeys.createdAt))
    return rows.map((k) => ({ id: k.id, label: k.label, prefix: k.prefix, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null }))
  })

  app.delete('/admin/api-keys/:id', { schema: { tags: ['admin'], params: z.object({ id: z.uuid() }), response: { 200: z.object({ revoked: z.boolean() }), 404: errorBody } } }, async (request) => {
    const rows = await deps.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, request.params.id)).returning({ id: apiKeys.id })
    if (rows.length === 0) throw notFound('api key')
    return { revoked: true }
  })
}
