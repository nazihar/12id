/**
 * API keys managed from the console (Phase 4 C1). Only the console principal may call these: an API
 * key that could mint or revoke API keys would turn one leaked key into many. The plaintext key
 * exists only in the creation response, which is never stored for idempotency replays.
 */
import { type SQL, and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

import { API_KEY_PREFIX, generateSecret, hashSecret, lookupPrefix } from '../../auth/tokens.ts'
import type { Database } from '../../db/client.ts'
import { apiKeys } from '../../db/schema.ts'
import { type TenantContext, requireConsolePrincipal } from '../auth.ts'
import { notFound } from '../errors.ts'
import { containsI, listPage, pageOf, pageQuery, searchQuery } from '../list.ts'

/** Routes with this tag are left out of the customer OpenAPI document (app.ts `hiddenTag`). */
export const CONSOLE_ONLY_TAG = 'console-only'

const errorBody = z.object({ error: z.string(), reason: z.string() })
const apiKeyView = z.object({ id: z.string(), label: z.string(), prefix: z.string(), createdAt: z.iso.datetime(), lastUsedAt: z.iso.datetime().nullable(), revokedAt: z.iso.datetime().nullable() })
const toApiKeyView = (row: typeof apiKeys.$inferSelect) => ({
  id: row.id,
  label: row.label,
  prefix: row.prefix,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
})
const tags = ['api-keys', CONSOLE_ONLY_TAG]

export const consoleRoutes = (deps: { db: Database }): FastifyPluginAsyncZod => async (app) => {
  const tenant = (request: { tenant?: TenantContext }) => requireConsolePrincipal(request.tenant as TenantContext, 'API keys are managed from the console')

  app.post(
    '/v1/api-keys',
    {
      config: { idempotency: false },
      schema: { tags, summary: 'Create an API key', description: 'The plaintext key is returned once.', body: z.object({ label: z.string().min(1).max(100) }), response: { 201: apiKeyView.extend({ apiKey: z.string() }), 403: errorBody } },
    },
    async (request, reply) => {
      const t = tenant(request)
      const apiKey = generateSecret(API_KEY_PREFIX)
      const [row] = await deps.db.insert(apiKeys).values({ tenantId: t.id, prefix: lookupPrefix(apiKey), keyHash: hashSecret(apiKey), label: request.body.label }).returning()
      return reply.code(201).send({ ...toApiKeyView(row), apiKey })
    }
  )

  app.get(
    '/v1/api-keys',
    {
      schema: {
        tags,
        summary: 'List API keys',
        description: 'Newest first, paged. `q` matches the label or the key prefix.',
        querystring: pageQuery.extend(searchQuery.shape).extend({ status: z.enum(['active', 'revoked']).optional() }),
        response: { 200: pageOf(apiKeyView), 403: errorBody },
      },
    },
    async (request) => {
      const { q, status } = request.query
      const filters: SQL[] = [eq(apiKeys.tenantId, tenant(request).id)]
      if (q) filters.push(or(containsI(apiKeys.label, q), containsI(apiKeys.prefix, q))!)
      if (status) filters.push(status === 'active' ? isNull(apiKeys.revokedAt) : isNotNull(apiKeys.revokedAt))
      const page = await listPage(deps.db, { table: apiKeys, where: filters, ...request.query }, (where, limit, offset) =>
        deps.db.select().from(apiKeys).where(where).orderBy(desc(apiKeys.createdAt), desc(apiKeys.id)).limit(limit).offset(offset)
      )
      return { ...page, items: page.items.map(toApiKeyView) }
    }
  )

  app.delete('/v1/api-keys/:id', { schema: { tags, summary: 'Revoke an API key', params: z.object({ id: z.uuid() }), response: { 200: apiKeyView, 403: errorBody, 404: errorBody } } }, async (request) => {
    const [row] = await deps.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.tenantId, tenant(request).id), eq(apiKeys.id, request.params.id), isNull(apiKeys.revokedAt)))
      .returning()
    if (!row) throw notFound('api key')
    return toApiKeyView(row)
  })
}
